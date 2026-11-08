// The Breakpoint logo. Inlined as a data URL so it renders inside YouTube's page (content-script
// shadow root) without web_accessible_resources, and in the popup alike.
import logo from './breakpoint-logo.png?inline';

/** Decorative by default (the surrounding text names Breakpoint); pass `label` when it stands alone. */
export function BrandMark({ size = 16, label }: { size?: number; label?: string }) {
  // Lowkey on YouTube: 14-18 px, softened (theme.css .bp-logo). The popup header uses a larger mark.
  return <img className="bp-logo" src={logo} width={size} height={size} draggable={false}
    alt={label ?? ''} aria-hidden={label ? undefined : true} />;
}
