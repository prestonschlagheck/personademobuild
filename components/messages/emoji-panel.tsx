"use client";

import { useRef, useState, type ReactNode } from "react";
import { cx, pt } from "@/components/ios/ui";

type Category = { id: string; label: string; icon: ReactNode; emoji: string[] };

const split = (list: string) => list.split(" ");

// Stroke glyphs for the category bar, drawn in a 24 x 24 box like the iOS emoji keyboard's own.
const glyph = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="size-19">
    <path d={d} />
  </svg>
);

const CATEGORIES: Category[] = [
  {
    id: "smileys",
    label: "Smileys & People",
    icon: glyph("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 14.5c1 1.4 2.3 2 4 2s3-.6 4-2M9 9.5v.5M15 9.5v.5"),
    emoji: split(
      "😀 😃 😄 😁 😆 😅 😂 🤣 🥲 ☺️ 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🫢 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 👽 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 💪 🧠 👀 👁️ 👅 👄 🫦 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙋 🙆 🙅 🤷 🤦 💁 🙇",
    ),
  },
  {
    id: "animals",
    label: "Animals & Nature",
    icon: glyph("M5 19c0-8 5-14 15-14 0 10-6 15-14 15M5 19l7-7"),
    emoji: split(
      "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🐢 🐍 🦎 🐙 🦑 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦒 🦘 🐪 🐄 🐎 🐖 🐑 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🕊️ 🐇 🦝 🦔 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🍃 🍂 🍁 🍄 🌾 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌚 🌙 🌎 🪐 💫 ⭐️ 🌟 ✨ ⚡️ ☄️ 💥 🔥 🌪️ 🌈 ☀️ 🌤️ ⛅️ 🌧️ ⛈️ ❄️ ☃️ ⛄️ 💨 💧 💦 🌊",
    ),
  },
  {
    id: "food",
    label: "Food & Drink",
    icon: glyph("M5 8h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V8ZM16 9.5h1.5a2.5 2.5 0 0 1 0 5H16M4 21h13"),
    emoji: split(
      "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 ☕️ 🫖 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾 🧊",
    ),
  },
  {
    id: "activity",
    label: "Activity",
    icon: glyph("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 9.5c3 1 6 .5 8.5-2s3.5-3.5 5.5-4M6 19c1-3.5 4-6 8-7s5.5-.5 7-.5"),
    emoji: split(
      "⚽️ 🏀 🏈 ⚾️ 🥎 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🏒 🏑 🥍 🏏 🥅 ⛳️ 🏹 🎣 🥊 🥋 🎽 🛹 🛼 ⛸️ 🥌 🎿 ⛷️ 🏂 🏋️ 🤸 🤺 ⛹️ 🏌️ 🏇 🧘 🏄 🏊 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩",
    ),
  },
  {
    id: "travel",
    label: "Travel & Places",
    icon: glyph("M4 16v-3.5L6 8h12l2 4.5V16H4ZM4 16v2.5M20 16v2.5M7.5 13h.5M16 13h.5"),
    emoji: split(
      "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛵 🏍️ 🚲 🛴 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 💺 🚀 🛸 🚁 🛶 ⛵️ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓️ ⛽️ 🚧 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲️ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺️ 🏠 🏡 🏘️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪️ 🕌 🕍 🛕 🌅 🌄 🌠 🎇 🎆 🌇 🌆 🏙️ 🌃 🌌 🌉 🌁",
    ),
  },
  {
    id: "objects",
    label: "Objects",
    icon: glyph("M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1v.5h6V15c0-.4.2-.8.5-1.1A6 6 0 0 0 12 3Z"),
    emoji: split(
      "⌚️ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🎙️ ⏰ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🧯 💸 💵 💰 💳 💎 ⚖️ 🧰 🔧 🔨 🛠️ ⛏️ 🔩 ⚙️ 🧲 🔫 💣 🔪 🛡️ 🔮 🧿 💈 🔭 🔬 🩺 💊 💉 🩹 🧬 🧪 🌡️ 🧹 🧺 🧻 🚽 🛁 🧼 🪥 🧽 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 🖼️ 🛍️ 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🎎 🏮 ✉️ 📩 📨 📧 💌 📦 🏷️ 📪 📬 📜 📃 📄 📑 📊 📈 📉 🗒️ 📆 📅 🗓️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🔗 📎 🖇️ 📐 📏 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓",
    ),
  },
  {
    id: "symbols",
    label: "Symbols",
    icon: glyph("M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.2 4.5 4.5 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z"),
    emoji: split(
      "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ ☯️ ☦️ 🛐 ⛎ ♈️ ♉️ ♊️ ♋️ ♌️ ♍️ ♎️ ♏️ ♐️ ♑️ ♒️ ♓️ 🆔 ⚛️ ☢️ ☣️ 📴 📳 🆚 💮 🉐 ㊙️ ㊗️ 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕️ 🛑 ⛔️ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗️ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿️ 🅿️ 🚹 🚺 🚼 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔢 #️⃣ *️⃣ ▶️ ⏸️ ⏯️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ 🔀 🔁 🔂 ◀️ 🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ ↪️ ↩️ ⤴️ ⤵️ 🔄 🔃 🎵 🎶 ➕ ➖ ➗ ✖️ 💲 💱 ™️ ©️ ®️ 〰️ ➰ ➿ 🔚 🔙 🔛 🔝 🔜 ✔️ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫️ ⚪️ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◾️ ◽️ ◼️ ◻️ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛️ ⬜️ 🟫 🔈 🔇 🔉 🔊 🔔 🔕 📣 📢 💬 💭 🗯️ ♠️ ♣️ ♥️ ♦️ 🃏 🎴 🀄️",
    ),
  },
  {
    id: "flags",
    label: "Flags",
    icon: glyph("M5 21V4M5 4c4.5-2 7 2 14 0v9c-7 2-9.5-2-14 0"),
    emoji: split(
      "🏳️ 🏴 🏁 🚩 🏳️‍🌈 🏳️‍⚧️ 🇺🇸 🇨🇦 🇲🇽 🇧🇷 🇦🇷 🇨🇴 🇬🇧 🇮🇪 🇫🇷 🇩🇪 🇪🇸 🇵🇹 🇮🇹 🇳🇱 🇧🇪 🇨🇭 🇸🇪 🇳🇴 🇩🇰 🇫🇮 🇵🇱 🇺🇦 🇬🇷 🇹🇷 🇮🇱 🇪🇬 🇳🇬 🇰🇪 🇿🇦 🇮🇳 🇵🇰 🇨🇳 🇯🇵 🇰🇷 🇹🇼 🇭🇰 🇸🇬 🇵🇭 🇻🇳 🇹🇭 🇮🇩 🇦🇺 🇳🇿",
    ),
  },
];

const RECENTS_ICON = glyph("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2");
const RECENTS_MAX = 30;
export const DEFAULT_RECENTS = split("😂 ❤️ 👍 🙏 😊 😭 🥹 😍 🔥 🙌 😅 👀 💯 🎉 🤔 😎 👋 🤝 ✅ 🥳 😬 🙂 👏 💪 😴 🤯 😇 🫶 ☕️ 📧");

/** Moves a picked emoji to the front of Frequently Used, as iOS does. */
export const withRecent = (recents: string[], emoji: string) => [emoji, ...recents.filter((e) => e !== emoji)].slice(0, RECENTS_MAX);

type EmojiPanelProps = {
  recents: string[];
  onPick: (emoji: string) => void;
  onDeleteDown: () => void;
  onDeleteUp: () => void;
  onLetters: () => void;
};

// The iOS emoji keyboard over the letter keys: a sideways-scrolling grid with a sticky section label, and a
// bar for ABC, the categories and delete. The art's own globe and mic row stays visible below it.
export function EmojiPanel({ recents, onPick, onDeleteDown, onDeleteUp, onLetters }: EmojiPanelProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState("recents");
  const sections = [{ id: "recents", label: "Frequently Used", icon: RECENTS_ICON, emoji: recents }, ...CATEGORIES];

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const current = [...el.querySelectorAll<HTMLElement>("[data-section]")].findLast((s) => s.offsetLeft <= el.scrollLeft + 1);
    if (current?.dataset.section) setActive(current.dataset.section);
  };

  const jump = (id: string) => {
    const el = scroller.current;
    const section = el?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (el && section) el.scrollTo({ left: section.offsetLeft, behavior: "smooth" });
  };

  return (
    <div className="absolute inset-x-0 top-0 flex flex-col bg-ios-keyboard" style={{ height: pt(270), borderRadius: `${pt(27)} ${pt(27)} 0 0` }}>
      <div
        ref={scroller}
        onScroll={onScroll}
        // A mouse wheel only scrolls up and down; the grid scrolls sideways, as a swipe does on the phone.
        onWheel={(e) => {
          if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY;
        }}
        className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]"
        style={{ paddingTop: pt(10) }}
      >
        {sections.map((section) => (
          <section key={section.id} data-section={section.id} aria-label={section.label} className="flex shrink-0 flex-col">
            <p
              className="sticky w-max text-ios-caption2 font-semibold text-ink-soft uppercase"
              style={{ left: pt(14), marginLeft: pt(14), height: pt(20) }}
            >
              {section.label}
            </p>
            <div
              className="grid grid-flow-col"
              style={{ gridTemplateRows: `repeat(5, ${pt(41)})`, gridAutoColumns: pt(46), paddingInline: pt(5) }}
            >
              {section.emoji.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  onClick={() => onPick(emoji)}
                  className="grid place-items-center rounded-[calc(var(--pt)*8)] leading-none active:bg-ink/10"
                  style={{ fontSize: pt(31) }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="flex shrink-0 items-center justify-between" style={{ height: pt(40), paddingInline: pt(8) }}>
        <button
          type="button"
          onClick={onLetters}
          className="rounded-[calc(var(--pt)*8)] text-ios-body text-ink active:bg-ink/10"
          style={{ width: pt(48), height: pt(34) }}
        >
          ABC
        </button>
        <div className="flex">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              aria-label={section.label}
              aria-pressed={active === section.id}
              onClick={() => jump(section.id)}
              className={cx(
                "grid place-items-center rounded-full",
                active === section.id ? "bg-ink/10 text-ink" : "text-ink-soft",
              )}
              style={{ width: pt(29), height: pt(29) }}
            >
              {section.icon}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Delete"
          onPointerDown={(e) => e.button === 0 && onDeleteDown()}
          onPointerUp={onDeleteUp}
          onPointerLeave={onDeleteUp}
          onPointerCancel={onDeleteUp}
          className="grid place-items-center rounded-[calc(var(--pt)*8)] text-ink active:bg-ink/10"
          style={{ width: pt(48), height: pt(34) }}
        >
          <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" className="h-17 w-24">
            <path d="M9.5 2H24a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9.5L2 10l7.5-8Z" />
            <path d="m13 6.5 7 7m0-7-7 7" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
