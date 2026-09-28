import Image from "next/image";
import { CloseIcon, DisclosureChevronIcon } from "@/components/ios/icons";
import { cx, PRESS, pt } from "@/components/ios/ui";
import type { EventMeta } from "@/lib/session/schema";
import { Avatar } from "./avatar";
import bubbleStyles from "./bubble.module.css";

// A shared contact, as iMessage draws a vCard: photo, name, and a chevron into the card.
export function ContactBubble({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Contact card for ${name}`}
      className={cx("flex w-240 not-first:mt-2 items-center gap-10 rounded-ios-bubble bg-ios-gray py-9 pl-9 pr-14 text-left", PRESS)}
    >
      <Avatar size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ios-body font-semibold text-ink">{name}</span>
        <span className="block text-ios-footnote text-ink-soft">Persona</span>
      </span>
      <DisclosureChevronIcon className="h-12 w-7 text-ios-gray-2" />
    </button>
  );
}

type Link = NonNullable<EventMeta["link"]>;

// Each preview is cropped from Persona's own card for the same link. Older events carry no preview and are Google's.
const PREVIEWS = {
  google: { src: "/links/connect-google.webp", height: 274 },
  dashboard: { src: "/links/open-dashboard.webp", height: 273 },
} as const;

type LinkCardProps = { link: Link; tail: boolean; onOpen: (url: string) => void };

// An iMessage rich link preview: Persona's preview image for the link, then the title and domain on the bubble gray,
// with the bubble tail when it ends the group. The whole card is the link, as in Messages: once sent it never changes,
// and every tap opens the same URL (the server sorts out a used or replaced sign-in).
export function LinkCard({ link, tail, onOpen }: LinkCardProps) {
  // Messages shows the domain under the title. Our link only bounces through the server to Google's sign-in,
  // so the card names where it lands; the dashboard link is ours.
  const detail = link.preview === "dashboard" ? URL.parse(link.url)?.hostname ?? "" : "accounts.google.com";
  const preview = PREVIEWS[link.preview ?? "google"];
  return (
    <button
      type="button"
      onClick={() => onOpen(link.url)}
      aria-label={`${link.title}, ${detail}`}
      className={cx(
        "relative isolate block w-264 not-first:mt-2 rounded-[calc(var(--pt)*18)] text-left",
        bubbleStyles.agent,
        tail && bubbleStyles.tail,
        PRESS,
      )}
    >
      <Image
        src={preview.src}
        alt=""
        width={526}
        height={preview.height}
        draggable={false}
        className="block h-auto w-full rounded-t-[calc(var(--pt)*18)]"
      />
      <span className="block px-12 pt-9 pb-10">
        <span className="block truncate text-ios-subhead font-semibold text-ink">{link.title}</span>
        <span className="block truncate text-ios-footnote text-ink-soft">{detail}</span>
      </span>
    </button>
  );
}

// The Maps location puck: a white-ringed blue dot in its soft accuracy halo.
function LocationPuck({ size }: { size: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-full bg-ios-blue/15" style={{ width: pt(size), height: pt(size) }} aria-hidden>
      <span
        className="rounded-full border-solid border-surface bg-ios-blue shadow-[0_calc(var(--pt)*1)_calc(var(--pt)*3)_#00000030]"
        style={{ width: pt(size * 0.48), height: pt(size * 0.48), borderWidth: pt(size * 0.07) }}
      />
    </span>
  );
}

/** What the request card can still do: share, say it was shared, or nothing (a newer request, a taken-back need, a stop). */
export type LocationState = "live" | "shared" | "closed";

type LocationRequestProps = { sender: string; state: LocationState; tail: boolean; onShare: () => void };

// iMessage's location request, as Persona's agent sent it: the puck, who is asking, and the Share My Location capsule.
// Tapping it asks the browser for a position, which leaves the page rounded to about 1 km.
export function LocationRequestCard({ sender, state, tail, onShare }: LocationRequestProps) {
  const live = state === "live";
  return (
    <div
      className={cx(
        "relative isolate flex w-250 not-first:mt-2 flex-col items-center rounded-[calc(var(--pt)*18)] px-12 pt-18 pb-12 text-center",
        bubbleStyles.agent,
        tail && bubbleStyles.tail,
      )}
    >
      <LocationPuck size={50} />
      <p className="mt-10 text-ios-callout text-ink">{sender} requested your location</p>
      <button
        type="button"
        onClick={onShare}
        disabled={!live}
        className={cx(
          "mt-22 h-36 w-full rounded-full text-ios-body font-semibold",
          live ? cx("bg-ios-blue text-surface", PRESS) : "bg-ios-fill text-ink-soft",
        )}
      >
        {state === "shared" ? "Location Shared" : "Share My Location"}
      </button>
    </div>
  );
}

// The point once sent, as Messages draws it on the sender's side: the puck and the device it comes from, on the
// bubble gray with the sent tail. No map, since that would need a tile service.
export function SharedLocationCard({ device, tail }: { device: string; tail: boolean }) {
  return (
    <div
      className={cx(
        "relative isolate flex w-250 not-first:mt-2 flex-col items-center rounded-[calc(var(--pt)*18)] px-16 pt-48 pb-52 text-center",
        bubbleStyles.sentCard,
        tail && bubbleStyles.tail,
      )}
    >
      <LocationPuck size={50} />
      <p className="mt-12 text-ios-callout text-balance text-ink">You’re sharing your location from “{device}”</p>
    </div>
  );
}

// Share My Location before it is sent: the same card waits in the composer, with a way to take it back.
export function StagedLocationCard({ device, onRemove }: { device: string; onRemove: () => void }) {
  return (
    <div className="relative flex flex-col items-center rounded-[calc(var(--pt)*16)] bg-ios-gray px-16 pt-40 pb-44 text-center">
      <button
        type="button"
        aria-label="Remove location"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRemove}
        className={cx("absolute top-8 right-8 grid size-26 place-items-center rounded-full bg-ios-gray-2 text-surface", PRESS)}
      >
        <CloseIcon className="size-12" />
      </button>
      <LocationPuck size={50} />
      <p className="mt-12 text-ios-callout text-balance text-ink">You’ll share your location from “{device}”</p>
    </div>
  );
}
