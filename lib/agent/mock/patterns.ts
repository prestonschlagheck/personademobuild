// The deterministic brain's vocabulary: intent patterns and word lists. Patterns are bounded by letters,
// not \b, so accented Spanish words match cleanly.

const BEFORE = "(?<![\\p{L}\\p{N}'])";
const AFTER = "(?![\\p{L}\\p{N}])";
// Each takes its alternatives in several strings, joined with "|", so long lists wrap cleanly.
const has = (...parts: string[]) => new RegExp(`${BEFORE}(?:${parts.join("|")})${AFTER}`, "iu");
const lead = (...parts: string[]) => new RegExp(`${BEFORE}(${parts.join("|")})\\s+(.+)`, "iu");
const whole = (...parts: string[]) => new RegExp(`^(?:${parts.join("|")})$`, "iu");
const NOT_NAMING = "(?! (?:you|u|ya|it|yourself)(?![\\p{L}]))";

export const P = {
  agentStrong: lead(
    "call yourself|name yourself|i'?ll call you|i will call you|i'?m (?:gonna|going to) call you|let'?s call you",
    "i want to call you|your name (?:is|will be|should be|can be)|your name'?s|you(?:'re| are) (?:called|named)",
    "ll[aá]mate|te vas a llamar|te llamar[aá]s|tu nombre (?:es|ser[aá])",
  ),
  agentSoft:
    /^(how about|what about|let'?s go with|let'?s do|go with|you can be|you'?ll be|maybe|i like|i choose|i pick|qu[eé] tal)\s+(.+)/iu,
  userStrong: lead(
    "my name(?: is|'s)|name'?s|i go by|you can call me|just call me|call me|they call me|people call me",
    "everyone calls me|i'?m called|me llamo|mi nombre es|ll[aá]mame",
  ),
  userSoft: lead("i'?m|im|i am|soy"),
  userContext: /^(it'?s|this is|es)\s+(.+)/iu,
  needObject: lead(
    "i (?:really )?need help with|i could use (?:some )?help with|i'?d love (?:some )?help with|i want help with",
    "i'?d like help with|need help with|help me with|help with|can you help (?:me )?with",
    "i (?:really )?(?:want|need) (?:some )?help|necesito ayuda con|ay[uú]dame con|quiero ayuda con",
  ),
  needTask: lead("can you|could you|would you|will you|i need you to|i want you to|i'?d like you to|please|puedes"),
  needVerb: has(
    "remind me to|keep track of|keep an eye on|stay on top of|get on top of|manage my|sort (?:out )?my|organize my",
    "clean up my|cancel my|book (?:me )?(?:a|an|my)|find me|schedule (?:a|my)|pay my|track my|deal with my|handle my",
    "order (?:me|us|some|a|an|my)|get me (?:a|an|some)|reply to|respond to|unsubscribe me",
  ),
  needWords: has(
    "inbox|e-?mails?|gmail|mail|unread|newsletters?|bills?|invoices?|payments?|rent|subscriptions?|memberships?",
    "calendar|meetings?|appointments?|flights?|trips?|travel|hotels?|itinerar(?:y|ies)|reservations?|packages?",
    "deliver(?:y|ies)|orders?|groceries|refunds?|taxes|correos?|facturas?|vuelos?",
  ),
  wantsHelp: whole("i (?:really )?(?:need|want) (?:some )?help|help|help me|i need something|necesito ayuda|ayuda"),
  callLaterStrong: has(
    "(?:call|ring) me (?:back )?(?:later|in|at|after|around|tomorrow|tonight)|ll[aá]mame (?:m[aá]s tarde|luego)",
  ),
  callLaterSoft: whole(
    "(?:maybe )?later(?: please)?|in a bit|in a few(?: min(?:utes)?)?|another time",
    "in \\d+ ?(?:m|min|mins|minutes|h|hr|hrs|hours?)|luego|m[aá]s tarde",
  ),
  callNo: has(
    "no calls?|don'?t call|do not call|no phone|rather (?:just )?text|rather not (?:call|talk|do a call)",
    "prefer (?:to )?text|(?:let'?s|can we|could we|we can|i'?ll) just text|just text|text is fine",
    "texting is (?:fine|better)|text me instead|keep going here|here is fine|can'?t talk|cannot talk|ahora no|no me llames",
  ),
  // Asking for a call in any words: "can we just call", "let's talk about it over the phone", "a call is easier".
  // A call word never takes "you" or "it" after it, which names the agent ("let's call you max").
  callYes: has(
    "call me|ring me|give me a (?:call|ring)|call now|phone me|call my (?:phone|cell|number)",
    "try me (?:again|one more time|now)|try calling (?:me )?again",
    `(?:can|could|shall|should|would|will) (?:we|you|u|ya) (?:just |maybe |please |quickly |instead )?(?:call|ring|phone)${NOT_NAMING}`,
    "(?:can|could|shall|should) (?:we|i) (?:just )?(?:do|have|hop on|jump on|get on|set up) (?:a |the )?(?:quick )?(?:phone |voice )?call",
    `let'?s (?:just )?(?:call${NOT_NAMING}|do a (?:quick )?call|do (?:this|it|the rest) (?:on|over) (?:the |a )?(?:phone|call))`,
    "(?:hop|jump|get) on (?:a |the )?(?:quick )?(?:phone |voice )?(?:call|phone)",
    "(?:talk|chat|speak|go over|discuss)(?: about)?(?: (?:it|this|that|everything|the rest))? (?:on|over|by) (?:the )?(?:phone|a call|call)",
    "(?:do|finish|handle) (?:this|it|the rest|everything) (?:on|over) (?:the |a )?(?:phone|call)",
    `(?:just|i'?d rather|i would rather|i'?d prefer to|i prefer to|i wanna|i want to|easier to) (?:just )?call${NOT_NAMING}`,
    "(?:a |the )?call (?:instead|would be (?:easier|better|faster|quicker)|is (?:easier|better|faster|quicker))",
    "(?:rather|prefer) (?:a |to )?(?:phone |voice )?call|(?:phone|voice) call (?:please|now|instead)",
    "ll[aá]mame|(?:podemos|puedes) (?:hablar por tel[eé]fono|llamar(?:me)?)|hablemos por tel[eé]fono|por tel[eé]fono",
  ),
  gmailFresh: has(
    "(?:new|fresh|another|different) link|link (?:again|expired|didn'?t work|isn'?t working|broke)",
    "wrong (?:account|email|gmail)|not the right (?:account|one|email)|send (?:it|the link) again|resend",
  ),
  // A new link for access they left unticked, which keeps a connected Gmail connected.
  gmailMore: has(
    "(?:add|connect|link|include|share|give you|access to) (?:my )?(?:google )?(?:calendar|drive)|(?:calendar|drive) too|more access",
    "(?:calendar|drive) (?:access|permission)|(?:tick|check|allow)(?:ed)? (?:the )?(?:calendar|drive)",
  ),
  gmailSkip: has(
    "skip (?:the )?(?:gmail|email|inbox|link|google)|no gmail|sin gmail|don'?t (?:want to )?connect|not connecting",
    "rather not connect|won'?t connect",
  ),
  gmailClaim: has(
    "(?:it'?s|gmail'?s|gmail is|email is|inbox is|it is) (?:connected|linked|hooked up)",
    "i (?:already )?(?:connected|linked) (?:it|gmail|my gmail|my email)|already connected|done connecting",
    "connected it",
    "(?:mark|set|flag|make) (?:my )?(?:gmail|email|inbox)(?: status)? (?:as |to )?(?:connected|linked|done)",
  ),
  gmailLink: has(
    "send (?:me )?(?:the |a |that )?(?:gmail |google )?link|connect (?:me (?:to|with) |my )?(?:gmail|email|inbox|google|calendar|drive)",
    "link (?:my )?(?:gmail|email|google)|gmail link|the link|link|m[aá]ndame el enlace|conectar gmail|el enlace",
  ),
  unverified: has(
    "not verified|isn'?t verified|unverified|hasn'?t verified|unsafe|scam|sketchy|security warning",
    "is (?:this|it) (?:safe|legit)|google (?:says|warns|is warning)",
  ),
  accountPicker: has("pick an account|choose an account|which account|asking me to (?:pick|choose)|select an account"),
  skipSetup: has(
    "skip (?:the )?(?:setup|set ?up|onboarding|all(?: of)?(?: this| it| that)?|everything|it all)|can we skip",
    "skip (?:the )?rest(?: of (?:the |this )?(?:setup|set ?up|onboarding|it|this))?",
    "let'?s skip|don'?t want to do (?:the |this |any )?(?:setup|set ?up|onboarding|this)|no setup",
    "forget (?:the )?setup|saltar todo",
  ),
  skipBare: whole("(?:\\p{L}+ )?skip(?: it| this| that)?"),
  // Taking the agent's offer to skip the rest, by its chip or in words.
  startNow: whole("start now|start on (?:it|that)|let'?s start|empezar ya|empecemos"),
  skipSlot: has(
    "rather not (?:say|share|tell)|i'?d rather not|prefer not to (?:say|share)|don'?t want to (?:say|share|tell)",
    "not telling|none of your business|no name|skip (?:my name|the name|name|that|this one|this question)|pass",
  ),
  // Asking to move on now. Urgency alone ("help with bills asap", "just help me") is how soon, not a skip.
  urgent: has("just do it|get started already|let'?s just go"),
  // Taking Google access back, which keeps everything else.
  disconnect: has(
    "(?:disconnect|unlink|revoke|remove|take back) (?:my |the )?(?:google|gmail|email|inbox)(?: (?:account|access))?",
    "(?:revoke|remove|take back) (?:your |the )?access to my (?:google|gmail|email|inbox)",
    "desconecta(?:r)? (?:mi )?(?:google|gmail|correo)",
  ),
  deleteNow: has(
    "delete everything|delete it all|delete all (?:of )?my (?:data|info|stuff)|wipe (?:everything|my data|it all)",
    "erase (?:everything|my data)|yes,? delete|confirm delete|borra todo|borrar todo",
  ),
  deleteAsk: has(
    "(?:delete|remove|erase|wipe) (?:all )?(?:of )?(?:my|me)(?: (?:data|info|information|account|stuff|history|messages))?",
    "forget (?:me|about me)",
  ),
  settings: has("settings|preferences|dashboard|account page|privacy controls|configuraci[oó]n|ajustes"),
  // They offer where they are, or ask to be asked, which also gets the card.
  locationOffer: has(
    "(?:ask|want|need)(?: me)?(?: for)? my (?:location|current location)|(?:want|need) to know where i am",
    "here'?s where i am|(?:can|let me|i'?ll|i want to|should i) share my location|use my location|mi ubicaci[oó]n",
  ),
  // A need that happens somewhere near them, which gets the location request card.
  placeNeed: has(
    "hair ?cuts?|barbers?|salons?|manicure|dentists?|doctors?|restaurants?|dinner reservation|table for|food|pizza",
    "takeout|take-out|sushi|tacos|coffee|groceries|near me|nearby|around here|close by|plumbers?|mechanic|car wash",
    "massage|pharmacy|peluquer[ií]a|cerca de m[ií]",
  ),
  speaks: has(
    "(?:do|can) (?:you|u) (?:speak|talk in|text in) (?:spanish|english)|(?:hablas|habla|puedes hablar) (?:en )?(?:espa[nñ]ol|ingl[eé]s)",
    "(?:in )?(?:spanish|english) please|en espa[nñ]ol(?: por favor)?",
  ),
  human: has(
    "are (?:you|u) (?:a |an )?(?:human|real|person|robot|bot|ai|machine|real person|actual person)",
    "is this (?:a |an )?(?:bot|human|real person|ai|robot)",
    "am i (?:talking|texting|speaking|chatting) (?:to|with) (?:a |an )?(?:human|bot|person|real person|ai|robot)",
    "eres (?:un |una )?(?:humano|humana|bot|ia|robot|persona real)",
  ),
  leak: has(
    "system prompt|initial prompt|what were you told|what (?:are|were) your (?:instructions|rules|guidelines)",
    "(?:show|reveal|print|repeat|tell me|give me|share) (?:me )?(?:your |the )?(?:system |hidden |original |initial )?(?:prompt|instructions|rules)",
  ),
  about: has(
    "what(?:'s| is) (?:a )?persona|who are you|what are you|what do you do|what can you do|how does this work",
    "qu[eé] es persona",
  ),
  why: has("why (?:do you (?:need|want)|should i (?:give|share|tell|connect)|would you need)"),
  whoIsThis: has("what(?:'s| is) your name|what (?:should|do) i call you|who is this|who'?s this"),
  graduateAsk: has("graduate|skip (?:the )?(?:setup|rest)|finish (?:the )?onboarding|mark (?:me|it) (?:as )?(?:done|complete)"),
  greeting: whole(
    "(?:hi+|hey+|hello+|yo+|sup|hiya|howdy|hola|buenas|hey there|hi there|good (?:morning|afternoon|evening))",
  ),
  thanks: has("thanks|thank you|thx|ty|tysm|appreciate it|gracias"),
  bye: has(
    "bye|goodbye|gotta go|got to go|have to go|i'?m out|talk (?:to you )?later|ttyl|that'?s (?:it|all)(?: for now)?",
    "i'?m done|nothing else|we'?re done|adi[oó]s",
  ),
  youPick: whole(
    "you pick|you choose|surprise me|idk|i don'?t know|dunno|anything|whatever|up to you|your choice|no idea",
    "you decide",
  ),
  affirm: whole(
    "y|ya|yes|yeah|yep|yup|sure|ok|okay|k|kk|alright|absolutely|definitely|of course|please|yes please|sounds good",
    "let'?s do it|do it|go ahead|bet|for sure|perfect|great|keep going|continue|go on|s[ií]|claro|dale|vale",
  ),
  // A yes wrapped in filler ("nice yes", "ok sure lol", "yes!! do it"): every word is a yes or filler, one a yes.
  yesish: new RegExp(
    `^(?=.*${BEFORE}(?:y|ya|yes|yeah|yea|yep|yup|sure|ok|okay|absolutely|definitely|of course|please|do it|go ahead|let'?s do it|let'?s go|sounds good|for sure|bet|s[ií]|claro|dale|vale)${AFTER})` +
      `(?:(?:y|ya|yes|yeah|yea|yep|yup|sure|ok|okay|k|kk|alright|absolutely|definitely|of course|please|yes please|sounds good|let'?s do it|let'?s go|do it|go ahead|bet|for sure|perfect|great|nice|cool|sweet|awesome|love it|oh|ah|haha|lol|yay|now|s[ií]|claro|dale|vale)[\\s,!.]*)+$`,
    "iu",
  ),
  deny: whole(
    "n|no|nope|nah|no thanks|no thank you|not now|not right now|not at the moment|not today|no not now|not really",
    "never ?mind|nvm|forget it|nah i'?m good|no gracias|ahora no",
  ),
  hold: whole(
    "wait|hold on|hang on|one sec(?:ond)?|one moment|just a (?:sec|second|minute)|give me a (?:sec|second|minute)",
    "one more thing|real quick|brb|un momento|espera",
  ),
  question: /\?\s*$|^(?:what|who|where|when|why|how|which|is|are|do|does|did|can|could|will|would|should)\b/i,
  spanish: has(
    "hola|gracias|quiero|necesito|ll[aá]mate|ll[aá]mame|me llamo|c[oó]mo|qu[eé]|claro|ayuda|correos?|por favor|buenas",
    "tengo|puedes|hablo|ingl[eé]s|espa[nñ]ol|nombre|ahora|llamada|s[ií]",
  ),
  english: has("the|and|you|i'?m|my|what|call|help|yes|please|hey|hi|hello|thanks"),
};

export const OFF_TOPIC: [RegExp, string][] = [
  [has("weather|forecast|temperature"), "can't check the weather just yet. once we're set up i'll be way more useful."],
  [has("joke|make me laugh|something funny"), "why did the inbox go to therapy? too many unresolved threads."],
  [has("who (?:made|built|created|owns|makes) (?:you|this)|who'?s behind (?:this|you)"), "the persona team built me."],
  [has(
    "(?:what|which) (?:model|llm|ai) (?:are you|is this|do you use)|are you (?:chat)?gpt|are you claude",
    "what (?:are you|is this) (?:built|running|made) (?:on|with)|(?:tech|software) stack|what do you run on",
  ), "i'm persona, built by the persona team."],
  [has("how are (?:you|u)|how'?s it going|how'?s your day|what'?s up|wyd"), "doing great, thanks for asking."],
  [has("meaning of life"), "42, last i checked."],
  [has("what time is it|what day is it|what'?s the (?:time|date)"), "your lock screen beats me on that one."],
];
export const MATH = /(-?\d+(?:\.\d+)?)\s*(\+|plus|-|minus|\*|x|times|\/|divided by)\s*(-?\d+(?:\.\d+)?)/i;

// Words that follow "i'm" or "call me" without being a name.
export const NOT_NAMES = new Set(
  (
    "a an the not just so very really here there back in on at from with of to for de good great fine ok okay well alright cool sure ready " +
    "busy tired bored done new sorry confused lost curious interested down up out over free late early hungry sick stressed " +
    "overwhelmed swamped happy sad excited glad still also only always never all both into about like kinda sorta pretty " +
    "super totally literally actually honestly basically seriously probably definitely usually mostly gonna going trying " +
    "looking wondering human real bot ai your you me my him her them it this that what who why how when where yes no yeah " +
    "nope nah maybe thanks thank hi hey hello sup yo lol haha btw tbh idk and or but if because then too more less some any " +
    "every none nobody someone somebody anyone anybody everyone everybody persona gmail google email inbox bills calendar " +
    "stop start skip later now soon tomorrow tonight today again please afraid aware certain positive available around home " +
    "away outside inside work school student driving asking calling texting waiting working thinking one two three " +
    "whatever anything something nothing whenever instead asap rn quick quickly right"
  ).split(" "),
);
// Words that can open a "call yourself x" capture without x being a name.
export const NOT_NAME_START = new Set(
  (
    "later back now soon tomorrow tonight again when whenever if in at on maybe a an the that this it what " +
    "whatever anything something please and or but so me i we us not you yourself"
  ).split(" "),
);
// Where a name capture ends: punctuation, or a word that starts the next thought.
const CUT_WORDS = [
  "and|but|because|cause|cuz|so|btw|lol|haha|please|pls|thanks",
  "i'?m|im|i am|my|call me|call yourself|i need|i want|who|from|y|pero",
];
export const CUT = new RegExp(`[,.!?;:\\n]|\\s(?:${CUT_WORDS.join("|")})(?![\\p{L}])`, "iu");
export const NEED_CUT = /[.!?;\n]|,\s*(?:and\s+)?(?:i'?m|my name|call (?:me|yourself))/iu;
export const FILLER_LEAD = /^(?:ok(?:ay)?|fine|then|um+|uh+|hmm+|well|so|maybe|i guess|just|and|also|oh|actually)\b[,\s]*/iu;
