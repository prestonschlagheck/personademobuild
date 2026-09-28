import { useId, type CSSProperties } from "react";

// Every glyph inside the phone. The status bar, header and composer set is taken from Persona's own iMessage
// mockup on yourpersona.com; the call and thread glyphs are drawn to sit with SF Symbols at their fill weight.
type IconProps = { className?: string; style?: CSSProperties };

// Right side of the iOS status bar (cellular, wifi, battery) in its native 402 x 22 frame.
export function StatusBarIcons({ className }: IconProps) {
  return (
    <svg viewBox="0 0 402 22" fill="currentColor" className={className} aria-hidden>
      <path fillRule="evenodd" clipRule="evenodd" d="M307.865 6.03307C307.865 5.40002 307.388 4.88684 306.798 4.88684H305.732C305.143 4.88684 304.665 5.40002 304.665 6.03307V15.967C304.665 16.6001 305.143 17.1133 305.732 17.1133H306.798C307.388 17.1133 307.865 16.6001 307.865 15.967V6.03307ZM300.431 7.33212H301.498C302.087 7.33212 302.564 7.85762 302.564 8.50586V15.9395C302.564 16.5878 302.087 17.1133 301.498 17.1133H300.431C299.842 17.1133 299.364 16.5878 299.364 15.9395V8.50586C299.364 7.85762 299.842 7.33212 300.431 7.33212ZM296.099 9.98117H295.033C294.444 9.98117 293.966 10.5134 293.966 11.1698V15.9246C293.966 16.5811 294.444 17.1132 295.033 17.1132H296.099C296.688 17.1132 297.166 16.5811 297.166 15.9246V11.1698C297.166 10.5134 296.688 9.98117 296.099 9.98117ZM290.798 12.4265H289.732C289.143 12.4265 288.665 12.9511 288.665 13.5982V15.9416C288.665 16.5887 289.143 17.1133 289.732 17.1133H290.798C291.388 17.1133 291.865 16.5887 291.865 15.9416V13.5982C291.865 12.9511 291.388 12.4265 290.798 12.4265Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M323.436 7.3021C325.924 7.3022 328.316 8.22428 330.118 9.87776C330.254 10.0054 330.471 10.0038 330.604 9.87415L331.902 8.61069C331.97 8.54493 332.007 8.45585 332.007 8.36317C332.006 8.27049 331.967 8.18184 331.899 8.11685C327.168 3.74214 319.704 3.74214 314.973 8.11685C314.905 8.1818 314.866 8.27041 314.865 8.3631C314.865 8.45578 314.902 8.54488 314.97 8.61069L316.268 9.87415C316.401 10.004 316.618 10.0056 316.754 9.87776C318.557 8.22418 320.949 7.30209 323.436 7.3021ZM323.433 11.5224C324.79 11.5223 326.099 12.034 327.105 12.9582C327.242 13.0893 327.456 13.0865 327.589 12.9517L328.876 11.6324C328.944 11.5632 328.981 11.4694 328.98 11.3718C328.979 11.2743 328.94 11.1812 328.871 11.1134C325.807 8.22254 321.062 8.22254 317.998 11.1134C317.929 11.1812 317.89 11.2743 317.889 11.3719C317.888 11.4695 317.925 11.5633 317.993 11.6324L319.28 12.9517C319.413 13.0865 319.627 13.0893 319.763 12.9582C320.769 12.0346 322.077 11.5229 323.433 11.5224ZM325.958 14.3159C325.959 14.4213 325.922 14.5228 325.855 14.5967L323.678 17.0514C323.615 17.1235 323.528 17.1641 323.437 17.1641C323.346 17.1641 323.259 17.1235 323.195 17.0514L321.018 14.5967C320.951 14.5228 320.914 14.4212 320.916 14.3158C320.918 14.2105 320.959 14.1107 321.029 14.0401C322.419 12.7262 324.455 12.7262 325.845 14.0401C325.915 14.1108 325.956 14.2106 325.958 14.3159Z" />
      <rect opacity="0.35" x="339.507" y="5" width="24" height="12" rx="3.8" fill="none" stroke="currentColor" />
      <path opacity="0.4" d="M365.007 9.28113V13.3566C365.812 13.0114 366.335 12.2085 366.335 11.3189C366.335 10.4293 365.812 9.6263 365.007 9.28113" />
      <rect x="341.007" y="6.5" width="21" height="9" rx="2.5" />
    </svg>
  );
}

export function BackChevronIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 17 28" fill="currentColor" className={className} aria-hidden>
      <path d="M0 13.8306C0.00813802 13.5457 0.0651042 13.2853 0.170898 13.0493C0.276693 12.8133 0.439453 12.5854 0.65918 12.3657L12.8906 0.524902C13.2406 0.174967 13.6719 0 14.1846 0C14.5264 0 14.8356 0.0813802 15.1123 0.244141C15.3971 0.406901 15.6209 0.626628 15.7837 0.90332C15.9546 1.18001 16.04 1.48926 16.04 1.83105C16.04 2.33561 15.8488 2.77913 15.4663 3.16162L4.40674 13.8184L15.4663 24.4873C15.8488 24.8779 16.04 25.3215 16.04 25.8179C16.04 26.1678 15.9546 26.4811 15.7837 26.7578C15.6209 27.0345 15.3971 27.2542 15.1123 27.417C14.8356 27.5879 14.5264 27.6733 14.1846 27.6733C13.6719 27.6733 13.2406 27.4943 12.8906 27.1362L0.65918 15.2954C0.431315 15.0757 0.264486 14.8478 0.158691 14.6118C0.0528971 14.3677 0 14.1073 0 13.8306Z" />
    </svg>
  );
}

export function DisclosureChevronIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 10 18" fill="currentColor" className={className} aria-hidden>
      <path d="M1.97845 0.335401C1.75318 0.118378 1.47894 1.16847e-06 1.16552 1.14107e-06C0.509305 1.0837e-06 5.4791e-07 0.512966 4.90992e-07 1.16404C4.62533e-07 1.48957 0.127327 1.78551 0.352596 2.0124L7.20862 8.75987L0.352595 15.4876C0.127325 15.7145 -8.07783e-07 16.0203 -8.3538e-07 16.336C-8.92299e-07 16.987 0.509304 17.5 1.16552 17.5C1.47894 17.5 1.75318 17.3816 1.96866 17.1646L9.58864 9.66742C9.86288 9.41094 10 9.09527 10 8.75C10 8.40474 9.86288 8.10879 9.59843 7.84245L1.97845 0.335401Z" />
    </svg>
  );
}

export function VideoIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden>
      <rect x="0.75" y="5.25" width="17.5" height="15.5" rx="3.25" />
      <path d="M18.6001 13.6682C18.2588 13.2881 18.2588 12.7119 18.6001 12.3318L23.256 7.14766C23.8687 6.46542 25 6.89885 25 7.81584L25 18.1842C25 19.1012 23.8687 19.5346 23.256 18.8524L18.6001 13.6682Z" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="22.55 17.91 12.9 12.9" fill="currentColor" className={className} aria-hidden>
      <path d="M23.25 25.0547C22.875 25.0547 22.5547 24.7422 22.5547 24.3594C22.5547 23.9766 22.875 23.6562 23.25 23.6562H28.3047V18.6094C28.3047 18.2344 28.6172 17.9141 29 17.9141C29.3828 17.9141 29.7031 18.2344 29.7031 18.6094V23.6562H34.75C35.125 23.6562 35.4453 23.9766 35.4453 24.3594C35.4453 24.7422 35.125 25.0547 34.75 25.0547H29.7031V30.1094C29.7031 30.4844 29.3828 30.8047 29 30.8047C28.6172 30.8047 28.3047 30.4844 28.3047 30.1094V25.0547H23.25Z" />
    </svg>
  );
}

// SF Symbols' waveform: the composer's audio message button.
export function WaveformIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className={className} aria-hidden>
      <path d="M4 10.5v3M8 7v10M12 4v16M16 8v8M20 10.5v3" />
    </svg>
  );
}

// location.fill, for Location in the plus menu.
export function LocationIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M20.3 3.2c.4-.2.8.2.6.6l-7.4 16.5c-.3.6-1.2.5-1.3-.2l-1-6.2c0-.2-.2-.4-.4-.4l-6.2-1c-.7-.1-.8-1-.2-1.3l15.9-8Z" />
    </svg>
  );
}

// Call glyphs: phone.fill, phone.down.fill, speaker.wave.3.fill, mic.slash.fill, message.fill, ellipsis,
// circle.grid.3x3.fill and clock.fill, all in a 24 x 24 box.

// A handset on the diagonal, symmetric about its middle so the rotated "down" variant stays true.
const HANDSET =
  "M5.6 3.3C6.4 2.7 7.5 2.8 8.1 3.6L10.6 6.8C11.1 7.4 11 8.3 10.4 8.8L9.4 9.6C9.1 9.9 9 10.3 9.2 10.7C10.2 12.3 11.7 13.8 13.3 14.8C13.7 15 14.1 14.9 14.4 14.6L15.2 13.6C15.7 13 16.6 12.9 17.2 13.4L20.4 15.9C21.2 16.5 21.3 17.6 20.7 18.4L19.8 19.5C18.8 20.7 17.2 21.2 15.7 20.7C10.2 18.9 5.1 13.8 3.3 8.3C2.8 6.8 3.3 5.2 4.5 4.2Z";

export function PhoneIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d={HANDSET} />
    </svg>
  );
}

export function PhoneDownIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d={HANDSET} transform="rotate(135 12 12)" />
    </svg>
  );
}

export function SpeakerIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M2.5 9.4C2.5 8.7 3 8.2 3.7 8.2H6.4L10.6 4.6C11.3 4 12.3 4.5 12.3 5.4V18.6C12.3 19.5 11.3 20 10.6 19.4L6.4 15.8H3.7C3 15.8 2.5 15.3 2.5 14.6Z" />
      <path
        d="M14.9 9.6A3.4 3.4 0 0 1 14.9 14.4M17.4 7.2A6.8 6.8 0 0 1 17.4 16.8M19.9 4.8A10.2 10.2 0 0 1 19.9 19.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function EllipsisIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <circle cx="5" cy="12" r="2.1" />
      <circle cx="12" cy="12" r="2.1" />
      <circle cx="19" cy="12" r="2.1" />
    </svg>
  );
}

export function KeypadIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      {[5, 12, 19].flatMap((cy) => [5, 12, 19].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.3" />))}
    </svg>
  );
}

export function MicSlashIcon({ className }: IconProps) {
  const cut = useId();
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <mask id={cut}>
        <rect width="24" height="24" fill="white" />
        <path d="M3.6 3.1L20.6 21.1" stroke="black" strokeWidth="5" strokeLinecap="round" />
      </mask>
      <g mask={`url(#${cut})`}>
        <rect x="8.2" y="2" width="7.6" height="13" rx="3.8" />
        <path d="M5.3 11.2A6.7 6.7 0 0 0 18.7 11.2M12 17.9V21.2M8.6 21.3H15.4" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      </g>
      <path d="M3.6 3.1L20.6 21.1" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

export function MessageIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 3.5C17.25 3.5 21.5 7.04 21.5 11.4C21.5 15.76 17.25 19.3 12 19.3C11 19.3 10.03 19.17 9.12 18.93C8.2 19.75 6.6 20.85 4.62 21.1C4.22 21.15 3.98 20.72 4.22 20.4C4.82 19.6 5.35 18.6 5.5 17.55C3.66 16.1 2.5 13.9 2.5 11.4C2.5 7.04 6.75 3.5 12 3.5Z" />
    </svg>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path
        fillRule="evenodd"
        d="M12 2.5A9.5 9.5 0 1 1 12 21.5A9.5 9.5 0 0 1 12 2.5ZM11.1 7.2A0.9 0.9 0 0 1 12.9 7.2V12H16.2A0.9 0.9 0 0 1 16.2 13.8H12A0.9 0.9 0 0 1 11.1 12.9Z"
      />
    </svg>
  );
}

// Thread glyphs: the graduated check, the send arrow, tapbacks, Google's "G" and copy.

export function CheckIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function SendArrowIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  );
}

export function CopyIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} style={style} aria-hidden>
      <rect x="8" y="8" width="12" height="13" rx="2.5" />
      <path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-7A2.5 2.5 0 0 0 4 5.5v8A2.5 2.5 0 0 0 6.5 16H8" />
    </svg>
  );
}

// Contact card glyphs: xmark, envelope.fill, shareplay (two windows), safari and video.fill.

// SF Symbols' arrowshape.turn.up.left, the Reply action in the message menu.
export function ReplyIcon({ className, style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className={className} style={style} aria-hidden>
      <path d="M10 5 3 11.5l7 6.5v-4c5 0 8.5 1.5 11 5-.8-5.5-4-10-11-10.5V5Z" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className={className} aria-hidden>
      <path d="M5 5l14 14M19 5L5 19" />
    </svg>
  );
}

export function EnvelopeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M4.6 5h14.8c.5 0 1 .1 1.4.4L13.1 12c-.6.5-1.6.5-2.2 0L3.2 5.4c.4-.3.9-.4 1.4-.4Z" />
      <path d="M2.3 6.6 8.6 12l-6.3 5.4c-.2-.4-.3-.8-.3-1.2V7.8c0-.4.1-.8.3-1.2Zm19.4 0c.2.4.3.8.3 1.2v8.4c0 .4-.1.8-.3 1.2L15.4 12l6.3-5.4ZM9.8 13l.4.4c1 .9 2.6.9 3.6 0l.4-.4 6.5 5.6c-.4.3-.9.4-1.3.4H4.6c-.5 0-.9-.1-1.3-.4L9.8 13Z" />
    </svg>
  );
}

export function ShareScreenIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden>
      <rect x="2.9" y="3.9" width="14.2" height="11.2" rx="2.4" />
      <rect x="6.9" y="8.9" width="14.2" height="11.2" rx="2.4" fill="currentColor" />
    </svg>
  );
}

export function CompassIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.6 8.4 13.3 13.3 8.4 15.6 10.7 10.7Z" fill="currentColor" strokeLinejoin="round" strokeWidth="1.2" />
    </svg>
  );
}

export function VideoFillIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 26 26" fill="currentColor" className={className} aria-hidden>
      <rect x="0" y="4.5" width="19" height="17" rx="4" />
      <path d="M20.2 11.6 23.5 7.9c.9-1 2.5-.4 2.5 1v8.2c0 1.4-1.6 2-2.5 1l-3.3-3.7a2 2 0 0 1 0-2.8Z" />
    </svg>
  );
}
