// The Google sign-in window and the thread's tab talk through one message, so the result lands in the
// thread the moment sign-in finishes instead of on the next poll.

const TYPE = "persona-oauth";

/** From /connect/done to the tab that opened sign-in. False when nothing opened this window. */
export function reportToOpener(result: string) {
  if (!window.opener) return false;
  window.opener.postMessage({ type: TYPE, result }, window.location.origin);
  return true;
}

export function isOAuthReport(event: MessageEvent<unknown>) {
  const { data } = event;
  return event.origin === window.location.origin && typeof data === "object" && data !== null && "type" in data && data.type === TYPE;
}
