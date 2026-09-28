"use client";

import { useEffect } from "react";
import { reportToOpener } from "@/lib/client/oauth-report";

// Opened from the thread (a popup on desktop, a new tab on a phone), this page reports back and closes.
// Opened any other way, it stays as the result page.
export function ReportToOpener({ result }: { result: string }) {
  useEffect(() => {
    if (reportToOpener(result)) window.close();
  }, [result]);
  return null;
}
