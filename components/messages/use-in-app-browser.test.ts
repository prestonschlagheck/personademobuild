import { describe, expect, it } from "vitest";
import { isInAppBrowser } from "./use-in-app-browser";

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)";

describe("isInAppBrowser", () => {
  it.each([
    ["Instagram", `${IOS} Mobile/15E148 Instagram 350.0.0.0.0 (iPhone16,1; iOS 18_0; en_US)`],
    ["Facebook", `${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0;FBBV/1]`],
    ["LinkedIn", `${IOS} Mobile/15E148 LinkedInApp/9.30`],
    ["TikTok on iOS", `${IOS} Mobile/15E148 musical_ly_36.0.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en`],
    ["TikTok on Android", `${ANDROID} Version/4.0 Chrome/128.0 Mobile Safari/537.36 trill_360000 BytedanceWebview/d8a21c6`],
    ["Snapchat", `${IOS} Mobile/15E148 Snapchat/13.10.0.40 (like Safari/8618.1.15, panda)`],
    ["WeChat", `${IOS} Mobile/15E148 MicroMessenger/8.0.50(0x18003237) NetType/WIFI Language/zh_CN`],
    ["Line", `${IOS} Mobile/15E148 Safari Line/14.13.0`],
    ["Pinterest", `${IOS} Mobile/15E148 [Pinterest/iOS]`],
    ["an Android webview", "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36"],
    ["an iOS app's webview", `${IOS} Mobile/15E148`],
    ["an iPad app's webview", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"],
  ])("flags %s", (_, userAgent) => {
    expect(isInAppBrowser(userAgent)).toBe(true);
  });

  it.each([
    ["Safari on iPhone", `${IOS} Version/18.0 Mobile/15E148 Safari/604.1`],
    ["Chrome on iPhone", `${IOS} CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1`],
    ["Firefox on iPhone", `${IOS} FxiOS/130.0 Mobile/15E148 Safari/605.1.15`],
    ["Chrome on Android", `${ANDROID} Chrome/128.0.0.0 Mobile Safari/537.36`],
    ["Safari on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"],
    ["Chrome on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"],
    ["an empty string", ""],
  ])("leaves %s alone", (_, userAgent) => {
    expect(isInAppBrowser(userAgent)).toBe(false);
  });
});
