import { useClientValue } from "@/lib/client/browser-store";

// In-app browsers block the mic and Google sign-in in webviews: Instagram, Facebook, X, LinkedIn, Slack, TikTok,
// Snapchat, WeChat, Line and Pinterest by name, and any Android webview by its "; wv)" token.
const IN_APP_BROWSER = /Instagram|FBAN|FBAV|FB_IAB|Twitter|LinkedInApp|Slack\/|musical_ly|BytedanceWebview|TikTok|Snapchat|MicroMessenger|\bLine\/|Pinterest|; wv\)/i;
// Any other iOS app's webview: WebKit without the "Safari/" token that Safari and every iOS browser app send.
const IOS_WEBVIEW = /\((?:iPhone|iPod|iPad);.*AppleWebKit(?!.*Safari\/)/;

export const isInAppBrowser = (userAgent: string) => IN_APP_BROWSER.test(userAgent) || IOS_WEBVIEW.test(userAgent);

export const useInAppBrowser = () => useClientValue(() => isInAppBrowser(navigator.userAgent), false);
