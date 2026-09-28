import { PostHogAnalytics } from "@/components/analytics/posthog";
import { CallLayer } from "@/components/call/call-layer";
import { MessagesApp } from "@/components/messages/messages-app";
import { Device } from "@/components/phone/device";
import { Stage } from "@/components/stage/stage";
import { CallProvider } from "@/lib/client/call-context";
import { OnboardingProvider } from "@/lib/client/onboarding";
import { StageUiProvider } from "@/lib/client/stage-ui";

export default function Page() {
  return (
    <StageUiProvider>
      <OnboardingProvider>
        <CallProvider>
          <Stage>
            <Device>
              <MessagesApp />
              <CallLayer />
            </Device>
          </Stage>
          <PostHogAnalytics />
        </CallProvider>
      </OnboardingProvider>
    </StageUiProvider>
  );
}
