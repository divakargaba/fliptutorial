import { browser } from 'wxt/browser';
import { isContentSender, requestApi } from '../src/api';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isContentSender(sender, browser.runtime.id)) return false;
    void requestApi(message, import.meta.env.WXT_API_BASE_URL || 'http://127.0.0.1:8000').then(sendResponse);
    return true;
  });
});
