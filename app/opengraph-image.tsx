import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { MARK, WORDMARK } from "@/components/brand/persona-logo";

export const alt = "Persona onboarding demo";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// ImageResponse cannot read CSS variables. Each constant below names the token it stands in for
// (app/globals.css), matched against the live components it borrows layout from: components/stage/stage.module.css
// (the brand row and the background mark), components/messages/bubble.module.css (bubble fill and radius),
// components/messages/header.tsx (the contact header) and components/stage/call-transcript.module.css (the caption).
const PAGE = "#f5f5f7"; // --color-page, the stage canvas
const INK = "#090909"; // --color-accent, the wordmark
const MARK_COLOR = "rgba(0,0,0,0.06)"; // --color-mark, the giant background logo
const AGENT_BUBBLE = "#e9e9eb"; // --color-ios-gray
const USER_BUBBLE_TOP = "#4ebaff"; // --color-ios-blue-top
const USER_BUBBLE_BOTTOM = "#0088ff"; // --color-ios-blue-bottom
const AGENT_TEXT = "#1d1d1f"; // --color-ink
const INK_SOFT = "#6e6e73"; // --color-ink-soft, timestamps and call captions
// The live caption is drawn in the mark's own 6%-black (call-transcript.module.css), quiet enough to read as
// texture rather than a panel. At that strength a credit line would not survive a link preview, so it is lifted
// to a legible tint of the same ink while keeping its weight, tracking, and lack of any pill or radius.
const CAPTION_COLOR = "rgba(9,9,9,0.58)";

// The agent name used everywhere in this mock thread and header (product voice: short, lowercase).
const AGENT_NAME = "milo";

// The frame is read when the image renders, which happens once at build (the route is static), never when the module
// loads: pages import this module for its metadata, and the worker they run on has no file system. Satori's <img>
// takes a data URI, and the SVG is small enough to inline.
async function frameSource(): Promise<string> {
  const svg = await readFile(join(process.cwd(), "public/ios/iphone-frame.svg"), "utf-8");
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// The device box: the same 435:906 frame ratio and the same left/top/width/height screen percentages as
// components/phone/phone.module.css, so the mock screen sits exactly under the bezel. Sized to fill most of
// the card's height while leaving the wordmark and caption their own room.
const PHONE_H = 600;
const PHONE_W = Math.round(PHONE_H * (435 / 906));
const SCREEN = {
  left: Math.round(PHONE_W * 0.04318),
  top: Math.round(PHONE_H * 0.02291),
  width: Math.round(PHONE_W * 0.91361),
  height: Math.round(PHONE_H * 0.95366),
};

// The app's own point system (--pt in app/globals.css) is 100cqw / 402: the screen crop is 402pt wide on any
// device. Scaling every header measurement below by this factor keeps the header's proportions (avatar size,
// button size, type size) true to the real app instead of guessed.
const PT = SCREEN.width / 402;
const pt = (n: number) => Math.round(n * PT);

// Satori calls .trim() on every declared style value, so a property must never be set to `undefined`
// (background here is always one string or the other, never toggled with backgroundImage).
function Bubble({ agent, children }: { agent?: boolean; children: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignSelf: agent ? "flex-start" : "flex-end",
        maxWidth: "78%",
        padding: "7px 11px",
        borderRadius: 15,
        fontSize: 11.5,
        lineHeight: 1.3,
        letterSpacing: "-0.01em",
        color: agent ? AGENT_TEXT : "#ffffff",
        background: agent ? AGENT_BUBBLE : `linear-gradient(${USER_BUBBLE_TOP}, ${USER_BUBBLE_BOTTOM})`,
      }}
    >
      {children}
    </div>
  );
}

// The call's own quiet caption line, styled like components/messages/rows.tsx CallRow: centered, no bubble,
// the ink-soft timestamp color, the title in the same weight bump iMessage gives a system row.
function CallRow({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", width: "100%", fontSize: 10.5, color: INK_SOFT, marginTop: 2 }}>
      <span style={{ fontWeight: 700 }}>{title}</span>
      <span>&nbsp;{detail}</span>
    </div>
  );
}

// A header icon button: the glass circle behind the back-chevron and video-call glyphs (styles.glass/.sheer
// in components/messages/messages.module.css, approximated here without the backdrop blur Satori can't do).
function IconCircle({ children }: { children: React.ReactNode }) {
  const d = pt(44);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: d,
        height: d,
        borderRadius: d,
        background: "rgba(255,255,255,0.6)",
      }}
    >
      {children}
    </div>
  );
}

// The Messages contact header (components/messages/header.tsx): back chevron, the round avatar carrying
// Persona's own mark once the contact card is saved (components/messages/avatar.tsx), the agent's name in a
// pill underneath, and the video-call glyph. Glyph paths are copied from components/ios/icons.tsx.
function ContactHeader() {
  const avatarSize = pt(58);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: `${pt(6)}px ${pt(16)}px 0` }}>
      <IconCircle>
        <svg viewBox="0 0 17 28" fill={AGENT_TEXT} width={pt(11)} height={pt(18)}>
          <path d="M0 13.8306C0.00813802 13.5457 0.0651042 13.2853 0.170898 13.0493C0.276693 12.8133 0.439453 12.5854 0.65918 12.3657L12.8906 0.524902C13.2406 0.174967 13.6719 0 14.1846 0C14.5264 0 14.8356 0.0813802 15.1123 0.244141C15.3971 0.406901 15.6209 0.626628 15.7837 0.90332C15.9546 1.18001 16.04 1.48926 16.04 1.83105C16.04 2.33561 15.8488 2.77913 15.4663 3.16162L4.40674 13.8184L15.4663 24.4873C15.8488 24.8779 16.04 25.3215 16.04 25.8179C16.04 26.1678 15.9546 26.4811 15.7837 26.7578C15.6209 27.0345 15.3971 27.2542 15.1123 27.417C14.8356 27.5879 14.5264 27.6733 14.1846 27.6733C13.6719 27.6733 13.2406 27.4943 12.8906 27.1362L0.65918 15.2954C0.431315 15.0757 0.264486 14.8478 0.158691 14.6118C0.0528971 14.3677 0 14.1073 0 13.8306Z" />
        </svg>
      </IconCircle>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: avatarSize,
            height: avatarSize,
            borderRadius: avatarSize,
            background: "#ffffff",
            border: "1px solid rgba(0,0,0,0.08)",
          }}
        >
          <svg width={avatarSize * 0.52} height={avatarSize * 0.5} viewBox="0 0 23.6813 23">
            <path d={MARK} fill={INK} />
          </svg>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            marginTop: pt(4),
            padding: `${pt(5)}px ${pt(11)}px`,
            borderRadius: 999,
            background: "rgba(255,255,255,0.7)",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "-0.01em", color: AGENT_TEXT }}>{AGENT_NAME}</span>
          <svg viewBox="0 0 10 18" fill="#8e8e93" width={pt(6)} height={pt(11)}>
            <path d="M1.97845 0.335401C1.75318 0.118378 1.47894 1.16847e-06 1.16552 1.14107e-06C0.509305 1.0837e-06 5.4791e-07 0.512966 4.90992e-07 1.16404C4.62533e-07 1.48957 0.127327 1.78551 0.352596 2.0124L7.20862 8.75987L0.352595 15.4876C0.127325 15.7145 -8.07783e-07 16.0203 -8.3538e-07 16.336C-8.92299e-07 16.987 0.509304 17.5 1.16552 17.5C1.47894 17.5 1.75318 17.3816 1.96866 17.1646L9.58864 9.66742C9.86288 9.41094 10 9.09527 10 8.75C10 8.40474 9.86288 8.10879 9.59843 7.84245L1.97845 0.335401Z" />
          </svg>
        </div>
      </div>

      <IconCircle>
        <svg viewBox="0 0 26 26" fill="none" stroke={AGENT_TEXT} strokeWidth="1.5" width={pt(15)} height={pt(15)}>
          <rect x="0.75" y="5.25" width="17.5" height="15.5" rx="3.25" />
          <path d="M18.6001 13.6682C18.2588 13.2881 18.2588 12.7119 18.6001 12.3318L23.256 7.14766C23.8687 6.46542 25 6.89885 25 7.81584L25 18.1842C25 19.1012 23.8687 19.5346 23.256 18.8524L18.6001 13.6682Z" />
        </svg>
      </IconCircle>
    </div>
  );
}

// The right-hand cluster of the iOS status bar (cellular, wifi, battery), the same glyph as
// components/ios/icons.tsx StatusBarIcons, cropped to just that cluster's slice of its native 402 x 22 frame.
function StatusBarGlyphs({ width }: { width: number }) {
  const height = Math.round((width * 22) / 82);
  return (
    <svg viewBox="286 0 82 22" fill={AGENT_TEXT} width={width} height={height}>
      <path fillRule="evenodd" clipRule="evenodd" d="M307.865 6.03307C307.865 5.40002 307.388 4.88684 306.798 4.88684H305.732C305.143 4.88684 304.665 5.40002 304.665 6.03307V15.967C304.665 16.6001 305.143 17.1133 305.732 17.1133H306.798C307.388 17.1133 307.865 16.6001 307.865 15.967V6.03307ZM300.431 7.33212H301.498C302.087 7.33212 302.564 7.85762 302.564 8.50586V15.9395C302.564 16.5878 302.087 17.1133 301.498 17.1133H300.431C299.842 17.1133 299.364 16.5878 299.364 15.9395V8.50586C299.364 7.85762 299.842 7.33212 300.431 7.33212ZM296.099 9.98117H295.033C294.444 9.98117 293.966 10.5134 293.966 11.1698V15.9246C293.966 16.5811 294.444 17.1132 295.033 17.1132H296.099C296.688 17.1132 297.166 16.5811 297.166 15.9246V11.1698C297.166 10.5134 296.688 9.98117 296.099 9.98117ZM290.798 12.4265H289.732C289.143 12.4265 288.665 12.9511 288.665 13.5982V15.9416C288.665 16.5887 289.143 17.1133 289.732 17.1133H290.798C291.388 17.1133 291.865 16.5887 291.865 15.9416V13.5982C291.865 12.9511 291.388 12.4265 290.798 12.4265Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M323.436 7.3021C325.924 7.3022 328.316 8.22428 330.118 9.87776C330.254 10.0054 330.471 10.0038 330.604 9.87415L331.902 8.61069C331.97 8.54493 332.007 8.45585 332.007 8.36317C332.006 8.27049 331.967 8.18184 331.899 8.11685C327.168 3.74214 319.704 3.74214 314.973 8.11685C314.905 8.1818 314.866 8.27041 314.865 8.3631C314.865 8.45578 314.902 8.54488 314.97 8.61069L316.268 9.87415C316.401 10.004 316.618 10.0056 316.754 9.87776C318.557 8.22418 320.949 7.30209 323.436 7.3021ZM323.433 11.5224C324.79 11.5223 326.099 12.034 327.105 12.9582C327.242 13.0893 327.456 13.0865 327.589 12.9517L328.876 11.6324C328.944 11.5632 328.981 11.4694 328.98 11.3718C328.979 11.2743 328.94 11.1812 328.871 11.1134C325.807 8.22254 321.062 8.22254 317.998 11.1134C317.929 11.1812 317.89 11.2743 317.889 11.3719C317.888 11.4695 317.925 11.5633 317.993 11.6324L319.28 12.9517C319.413 13.0865 319.627 13.0893 319.763 12.9582C320.769 12.0346 322.077 11.5229 323.433 11.5224ZM325.958 14.3159C325.959 14.4213 325.922 14.5228 325.855 14.5967L323.678 17.0514C323.615 17.1235 323.528 17.1641 323.437 17.1641C323.346 17.1641 323.259 17.1235 323.195 17.0514L321.018 14.5967C320.951 14.5228 320.914 14.4212 320.916 14.3158C320.918 14.2105 320.959 14.1107 321.029 14.0401C322.419 12.7262 324.455 12.7262 325.845 14.0401C325.915 14.1108 325.956 14.2106 325.958 14.3159Z" />
      <rect opacity="0.35" x="339.507" y="5" width="24" height="12" rx="3.8" fill="none" stroke={AGENT_TEXT} />
      <path opacity="0.4" d="M365.007 9.28113V13.3566C365.812 13.0114 366.335 12.2085 366.335 11.3189C366.335 10.4293 365.812 9.6263 365.007 9.28113" />
      <rect x="341.007" y="6.5" width="21" height="9" rx="2.5" />
    </svg>
  );
}

// The status bar row: "9:41" as a plain text node (Satori doesn't reliably lay out SVG <text>, so the clock
// stays HTML, unlike the glyph cluster which is path-only and safe to inline as SVG) and the glyph cluster.
function StatusBar() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${pt(20)}px ${pt(34)}px 0 ${pt(52)}px` }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "-0.01em", color: AGENT_TEXT }}>9:41</span>
      <StatusBarGlyphs width={Math.round(SCREEN.width * 0.2)} />
    </div>
  );
}

export default async function OpenGraphImage() {
  const frameSrc = await frameSource();
  return new ImageResponse(
    (
      <div style={{ display: "flex", position: "relative", width: "100%", height: "100%", background: PAGE }}>
        {/* The huge tone-on-tone mark behind everything, off to the right (stage.module.css .mark). */}
        <svg style={{ position: "absolute", right: -70, top: -30 }} width="700" height="680" viewBox="0 0 23.6813 23">
          <path d={MARK} fill={MARK_COLOR} />
        </svg>

        {/* Wordmark, top left, on the brand row's line (stage.module.css .brand / .wordmark). */}
        <svg style={{ position: "absolute", top: 52, left: 56 }} width="170" height="34" viewBox="0 0 115.435 23">
          <path d={MARK} fill={INK} />
          <path d={WORDMARK} fill={INK} />
        </svg>

        {/* The device, centered, with a status bar, a contact header and a fuller onboarding thread underneath. */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            top: (size.height - PHONE_H) / 2,
            left: (size.width - PHONE_W) / 2,
            width: PHONE_W,
            height: PHONE_H,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              position: "absolute",
              left: SCREEN.left,
              top: SCREEN.top,
              width: SCREEN.width,
              height: SCREEN.height,
              background: "#ffffff",
              // The display's own corner radius, so the screen's corners never show past the bezel's inner curve.
              borderRadius: pt(58),
              overflow: "hidden",
            }}
          >
            <StatusBar />
            <ContactHeader />
            <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: `${pt(6)}px 10px 10px`, gap: 7 }}>
              {/* The app's real opening lines, then the naming exchange a visitor would see. */}
              <Bubble agent>Hey! I&apos;m your new personal assistant</Bubble>
              <Bubble agent>What do you want to call me?</Bubble>
              <Bubble>milo</Bubble>
              <Bubble agent>milo it is. a quick call is usually easier than a long setup over text. want me to ring you now?</Bubble>
              <Bubble>yeah, go for it</Bubble>
              <CallRow title="Audio call" detail="1:58" />
            </div>
          </div>
          <img src={frameSrc} alt="" width={PHONE_W} height={PHONE_H} style={{ position: "absolute", inset: 0 }} />
        </div>

        {/* The credit, styled like the live call caption beside the phone: no pill, no radius, the caller's weight.
            Pinned to the bottom-left corner on the wordmark's margins, mirroring the brand row above it. */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            left: 56,
            bottom: 44,
            fontSize: 28,
            lineHeight: 1.18,
            letterSpacing: "-0.02em",
            fontWeight: 700,
            color: CAPTION_COLOR,
            textAlign: "left",
          }}
        >
          Demo by Preston Schlagheck
        </div>
      </div>
    ),
    size,
  );
}
