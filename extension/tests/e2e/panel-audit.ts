import type { Page } from '@playwright/test';

// Focused browser-computed WCAG 2.2 SC 1.4.3 audit. Walks the actual MV3 shadow
// tree, composites translucent backgrounds and uses the AA large-text thresholds.
// This is a regression check, not a claim of full WCAG conformance.
export async function auditPanel(page: Page) {
  return page.locator('.bp-panel').evaluate(panel => {
    type Color = [number, number, number, number];
    const parse = (value: string): Color => {
      const parts = value.match(/[\d.]+/g)!.map(Number);
      return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
    };
    const over = (fg: Color, bg: Color): Color => [
      fg[0] * fg[3] + bg[0] * (1 - fg[3]),
      fg[1] * fg[3] + bg[1] * (1 - fg[3]),
      fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1,
    ];
    const luminance = (color: Color) => color.slice(0, 3).map(channel => {
      const v = channel / 255;
      return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i]!, 0);
    const contrastFailures: Array<{ text: string; ratio: number; required: number; color: string }> = [];
    const controlFailures: string[] = [];
    let checkedTextNodes = 0;
    let minimumRatio = Infinity;
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const el = node.parentElement!;
      if (!node.textContent?.trim() || el.closest('[aria-hidden="true"], [inert]')) continue;
      const style = getComputedStyle(el);
      if (!el.getClientRects().length || style.visibility === 'hidden') continue;
      const ancestors: Element[] = [];
      for (let parent: Element | null = el; parent; parent = parent.parentElement) ancestors.unshift(parent);
      let background: Color = [255, 255, 255, 1];
      for (const ancestor of ancestors) background = over(parse(getComputedStyle(ancestor).backgroundColor), background);
      const foreground = over(parse(style.color), background);
      const a = luminance(foreground), b = luminance(background);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const size = parseFloat(style.fontSize);
      const required = size >= 24 || (size >= 18.667 && parseInt(style.fontWeight) >= 700) ? 3 : 4.5;
      checkedTextNodes++;
      minimumRatio = Math.min(minimumRatio, ratio);
      if (ratio < required) contrastFailures.push({ text: node.textContent.trim(), ratio: +ratio.toFixed(2), required, color: style.color });
    }
    for (const control of panel.querySelectorAll<HTMLElement>('button, [role="textbox"]')) {
      if (!control.getAttribute('aria-label')?.trim() && !control.textContent?.trim()) controlFailures.push(`Unnamed ${control.tagName}`);
      // Native contenteditable elements participate in tab order without a tabindex attribute.
      if (!control.matches(':disabled') && !control.isContentEditable && control.tabIndex < 0) controlFailures.push(`Unreachable ${control.textContent}`);
    }
    if (!panel.getAttribute('aria-labelledby') || !panel.querySelector('#bp-heading')) controlFailures.push('Panel heading missing');
    if (!panel.querySelector('[aria-live], [role="status"]')) controlFailures.push('Result announcement missing');
    return { checkedTextNodes, minimumRatio, contrastFailures, controlFailures };
  });
}
