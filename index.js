/*
 * Story Tracker — SillyTavern Extension v1.16.1
 * Keeps track of Time, Date, Location, Character Positions, and Recent Events.
 * Reduces amnesia by injecting scene context into LLM prompts.
 *
 * v1.16.1: The Turn Bus is asked as member "story_tracker" — its own switch
 *          in Character Library's Global settings can keep this pass on its
 *          own request (and then it is not detached either).
 * v1.16.0: Integrated turn. When Character Library's Turn Bus is on
 *          (window.CLTurnBus), the automatic scene analysis hands its prompt to
 *          the bus instead of sending its own request; the bus answers with
 *          this task's JSON (parsed and applied here exactly as before), or
 *          null — then the classic request runs. The automatic pass is also
 *          detached from CHARACTER_MESSAGE_RENDERED while the bus is on, so it
 *          does not hold the reply's event chain while the batch waits.
 *          Manual updates never go through the bus.
 * v1.15.0: The HUD can fold away the character details (positions, custom
 *          fields, pictures) and keep only time, place and weather — a button
 *          in the HUD head, remembered in settings.hudDetails. The prompt still
 *          gets everything; this only shortens the panel.
 * v1.14.0: StoryTrackerAPI.getAppearance(name) — how ONE character looks right now
 *          (state, the custom fields such as "Clothes", what the Inventory says
 *          they wear), for whoever draws them. Scene Director drew the card's
 *          dress over a character the tracker had in a bathrobe.
 * v1.13.1: The picture viewer is the shape of its picture again: the window
 *          hugs the fitted image (a portrait opens as a portrait), and the
 *          prompt under it wraps instead of stretching the window sideways.
 *          Zoom and pan happen inside that frame.
 * v1.13.0: The picture viewer zooms and pans (wheel towards the cursor, drag,
 *          click for fit ↔ actual pixels, "open full size" in a new tab), and
 *          pictures in the HUD can be folded away with the button in its head
 *          — the eye of each entry still opens its picture.
 * v1.12.0: A world clock is not an inference. Where Lore World keeps the time
 *          of the world this chat is set in, the analysis no longer guesses
 *          time / date / weekday out of the prose — it asks the owner. The
 *          API learns `day_of_week` (read and write) for the same reason.
 * v1.11.1: A reload is not a turn. SillyTavern replays the opening
 *          MESSAGE_RECEIVED / CHARACTER_MESSAGE_RENDERED pair every time a
 *          one-message chat is opened, so reopening an untouched new chat used
 *          to creep the auto-update counter and buy an analysis of a scene
 *          already stored in chat metadata.
 * v1.11.0: Visualize — an eye on every tracked entry. It draws the SUBJECT the
 *          entry belongs to, not the entry: a character's pose, clothes and
 *          custom fields are one person and make one picture.
 */

var MODULE = "story-tracker";
var DATA_KEY = "story_tracker_data";

// --- Scene-change broadcast (bridge to Lore Atlas & co) ---
// Fire-and-forget event on ST's shared bus. Listeners are optional: the
// tracker doesn't know or care whether Lore Atlas is installed.
var ST_SCENE_EVENT = "story_tracker_scene_change";
var lastSceneEmit = { chatId: "", idx: -1 };

// --- Prompts ---
var UPDATE_PROMPT_BASE =
    "[OOC: You are a narrative assistant. Analyze the roleplay chat so far and determine the current scene context.\n\n" +
    "1. TIME & CONDITIONS: Deduce the current Time (HH:MM), specific Location, current Temperature (e.g. '18°C' or '64°F'), and Weather conditions (e.g. 'Clear', 'Rainy', 'Overcast', 'Snowing', 'Stormy', 'Hot', 'Foggy'). If indoors or weather is unspecified, infer from context or write 'Unknown' for temperature/weather only. Time MUST progress logically based on recent actions.\n" +
    "2. DATE & DAY OF WEEK — MANDATORY, NEVER USE 'Unknown': You MUST always fill both 'date' and 'day_of_week'. Rules:\n" +
    "   - 'date': use DD/MM/YYYY for a real or clearly-numbered calendar; otherwise invent a fitting date in the story's own calendar (e.g. '3rd of Frostmoon, Year 1245').\n" +
    "   - 'day_of_week': the name of the weekday for that date. Use real weekday names (Monday…Sunday) unless the story has already established its own named days — then use those.\n" +
    "   - A scene that feels outside normal time (dreams, liminal spaces, a place seemingly outside time, etc.) still gets a date and a day name — invent one that fits the mood. 'Unknown' is NOT an acceptable value under any circumstances for either field.\n" +
    "3. CITY & COUNTRY — MANDATORY, NEVER USE 'Unknown': You MUST always fill both 'city' and 'country' fields with a real or invented name. Rules:\n" +
    "   - Real-world setting → use the actual city and country (e.g. 'Paris' / 'France').\n" +
    "   - Fantasy / sci-fi / fictional world → INVENT fitting names based on the story tone, character names, culture, architecture, language style. Be creative and specific (e.g. 'Myrenveld' / 'Sovereign Realms of Drak'hara').\n" +
    "   - Known fictional universe (Westeros, Middle-earth, etc.) → use canonical place names.\n" +
    "   - Setting is ambiguous or unspecified → make your BEST GUESS or freely invent. 'Unknown' is NOT an acceptable value under any circumstances.\n" +
    "4. CHARACTER POSITIONS: List every character present in the current scene (including {{user}} / the user). State exactly where they are and what their physical posture/action is right now (e.g., 'sitting on the bed', 'standing near the window', 'holding a knife').\n" +
    "   IDENTITY — ONE PERSON, ONE ENTRY. The list below of who was tracked last turn may name people by ROLE because the story had not named them yet ('the secretary', 'the guard', 'a hooded man'). The moment the story gives that person a name, use the NAME and drop the role entry: they are the same person, and listing both would put two people in the room where there is one. When a name is listed under KNOWN CHARACTER CARDS, spell it exactly as it appears there.\n" +
    "5. RECENT EVENTS: Write a brief, factual 1-2 sentence summary of what *just* changed or happened in the last few messages (e.g., 'User picked up a fork. Character 1 moved to the corridor.').\n";

// Builds the CUSTOM FIELDS instruction block + the "custom" part of the JSON example,
// based on the user-defined tracking parameters in settings.customFields.
function buildCustomFieldsPromptParts() {
    var fields = (settings.customFields || []).filter(function (f) { return f && f.label; });
    if (fields.length === 0) return { instructions: "", jsonExample: "" };

    var lines = fields.map(function (f, i) {
        var hint = f.hint ? " — " + f.hint : "";
        return "   - \"" + f.id + "\" (" + f.label + ")" + hint + ": for EACH character present, give a short current value for this parameter.";
    });
    var instructions =
        "6. CUSTOM TRACKED PARAMETERS: In addition to the above, track these user-defined parameters PER CHARACTER (including {{user}} if relevant), updating them based on what has happened so far:\n" +
        lines.join("\n") + "\n" +
        "   Keep each value short (a few words). If a parameter doesn't apply to a character, use 'N/A'.\n";

    var exampleEntries = fields.map(function (f) { return "\"" + f.id + "\":\"" + f.label + " value\""; }).join(", ");
    var jsonExample = ", \"custom\":{\"User\":{" + exampleEntries + "}, \"Char1\":{" + exampleEntries + "}}";

    return { instructions: instructions, jsonExample: jsonExample };
}

function buildUpdatePrompt() {
    var custom = buildCustomFieldsPromptParts();
    var prompt = UPDATE_PROMPT_BASE + custom.instructions + "\n" +
        "{{PREVIOUS_STATE}}\n\n" +
        "Respond ONLY with valid JSON in the story's language. Use this exact structure (date, day_of_week, city and country MUST be non-empty strings, never 'Unknown'):\n" +
        "{\"time\":\"14:30\", \"date\":\"15/06/2024\", \"day_of_week\":\"Saturday\", \"location\":\"Living room\", \"city\":\"Myrenveld\", \"country\":\"Sovereign Realms of Drak'hara\", \"temperature\":\"18°C\", \"weather\":\"Cloudy\", \"characters\":[{\"name\":\"User\", \"state\":\"sitting on floor\"}, {\"name\":\"Char1\", \"state\":\"standing near User\"}], \"recent_events\":\"Char1 entered the living room and spoke to User.\"" + custom.jsonExample + "}\n" +
        "]";
    return prompt;
}

// Fallback prompt — used when city/country is still unknown after main update
var CITY_COUNTRY_PROMPT =
    "[OOC: Based on the roleplay chat so far, determine the city/settlement and country/realm of the current scene.\n\n" +
    "Current known location: {{LOCATION}}\n\n" +
    "Rules (STRICTLY FOLLOW):\n" +
    "- If this is a real-world setting: provide the actual city and country.\n" +
    "- If this is a fantasy, sci-fi, or fictional world: INVENT a creative, fitting city name and realm/country name that matches the story's tone, culture, and character names. Be specific — never use generic placeholders.\n" +
    "- If you recognize a known fictional universe (Westeros, Middle-earth, Star Wars, etc.): use canonical place names.\n" +
    "- 'Unknown' is FORBIDDEN. You MUST always output a real or invented name.\n\n" +
    "Respond ONLY with valid JSON: {\"city\": \"CityName\", \"country\": \"CountryOrRealm\"}\n" +
    "]";

// --- State Variables ---
var settings = {
    enabled: true,
    showHUD: true,
    hudScale: 100,            
    hudPosition: "bottom-right",
	showChatButton: true,
    autoUpdate: true,
    autoUpdateInterval: 3,
    injectToContext: true,
    showHistory: true,
    showCityCountry: false,
    // --- Custom tracking fields (user-defined parameters, e.g. "Emotional State", "Growth Level") ---
    customFields: [], // [{id, label, hint}]
    customFieldPresets: [], // [{name, fields:[{id,label,hint}]}] — saved sets of custom fields, reusable across chats
    broadcastScene: true, // emit scene-change events for other extensions (Lore Atlas bridge)
    // --- Visualize (AutoIllustrator bridge) ---
    visualize: true,          // kill-switch: no eye, no bridge, no cache
    vizRefine: false,         // OFF: the prompt is built in code, zero LLM calls per click
    vizUseBackground: true,   // send auto-background's picture as a SCENE reference
    vizPreset: "",            // AutoIllustrator preset id ("" = whichever is active)
    vizThumbs: true,          // pictures shown inline in the HUD; false = folded away, the eye still opens them
    hudDetails: true,         // character rows in the HUD; false = only time, place and weather
    // --- Connection profile support ---
    useConnectionProfile: false, // master toggle: route Story Tracker analysis through a separate profile
    connectionProfile: "",       // name of the profile to use (empty = current/main profile)
    _restoreProfile: ""          // internal: profile to restore if an analysis was interrupted by a reload
};
var extSettings = null, saveFn = null, scriptModule = null, genQuiet = null, translateFn = null;
var runSlash = null; // executeSlashCommandsWithOptions — used to switch connection profiles
var storyData = null; 
var msgCounter = 0;
var busy = false;

// --- Init ---
jQuery(async function () {
    try {
        var m = await import("../../../extensions.js");
        extSettings = m.extension_settings;
        scriptModule = await import("../../../../script.js");
        if (typeof scriptModule.generateQuietPrompt === "function") genQuiet = scriptModule.generateQuietPrompt;
        /* extensions.js IMPORTS saveSettingsDebounced without re-exporting it —
           its only `export {}` block carries getContext, getApiUrl and
           SimpleMutex. Reading it there left save() a reader with no writer
           (§6.3). Context object first, script.js as the fallback. */
        try { var c = SillyTavern.getContext(); if (c && typeof c.saveSettingsDebounced === "function") saveFn = c.saveSettingsDebounced; } catch (eCtx) { }
        if (typeof saveFn !== "function" && typeof scriptModule.saveSettingsDebounced === "function") saveFn = scriptModule.saveSettingsDebounced;
        if (typeof saveFn !== "function") console.error("[Story Tracker] saveSettingsDebounced unavailable on both getContext() and script.js — settings will NOT persist");

        // Optional: slash-command runner, needed to switch connection profiles.
        // Wrapped in its own try so a path change in ST never breaks the whole extension.
        try {
            var sc = await import("../../../slash-commands.js");
            if (typeof sc.executeSlashCommandsWithOptions === "function") runSlash = sc.executeSlashCommandsWithOptions;
        } catch (e) { console.warn("[Story Tracker] slash-commands.js not available, connection profile switching disabled.", e); }
        
        await initTranslation();
        loadSettings();
        
        buildModal();
        buildHUD();
        buildSettingsPanel();
        buildChatButton();
        bindEvents();
        stVizBindEvents();
        installStoryTrackerApi();
        stBindLangSwitch();          // §9.2

        // Safety net: restore the main profile if a previous analysis was interrupted
        // by a page reload. Runs after a short delay so Connection Manager finishes loading.
        setTimeout(function () { recoverProfileIfNeeded(); }, 1500);

        console.log("[Story Tracker] v1.16.1 loaded — integrated turn (Character Library Turn Bus)");
    } catch (e) { console.error("[Story Tracker] Init error:", e); }
});

// --- Data Management ---
function loadSettings() {
    if(extSettings) {
        if(!extSettings[MODULE]) extSettings[MODULE] = {};
        Object.assign(settings, Object.assign({}, settings, extSettings[MODULE]));
        extSettings[MODULE] = settings;
    }
}

/* One warning per session, not per call. */
var saveMissingWarned = false;
function save() {
    if (saveFn) { saveFn(); return; }
    if (!saveMissingWarned) { saveMissingWarned = true; console.error("[Story Tracker] save(): no saveSettingsDebounced — settings changes are being dropped"); }
}

function makeDefaultData() {
    return {
        time: "--:--", date: "Unknown", day_of_week: "Unknown", location: "Unknown",
        city: "Unknown", country: "Unknown",
        temperature: "Unknown", weather: "Unknown",
        characters: [], recent_events: "Story just started.",
        custom: {},
        history: [], _initialized: false, _msgCount: 0
    };
}

function loadStoryData() {
    var meta = scriptModule ? scriptModule.chat_metadata : null;
    var stored = (meta && meta[DATA_KEY]) ? meta[DATA_KEY] : null;
    if (stored) {
        storyData = stored;
        msgCounter = storyData._msgCount || 0;
        if (!storyData.history) storyData.history = [];
        if (!storyData.custom || typeof storyData.custom !== "object") storyData.custom = {};
        /* Upgrade path for chats tracked before the replay guard existed: they
           carry no stamp, so the first reload would still spend one analysis
           learning what it already knew. At LOAD time nothing new has arrived,
           and an initialized tracker's data was produced FROM the messages on
           screen — so the turn at the end is by definition one this extension
           already saw. Seed it instead of paying to find out. Only for an
           initialized tracker: a fresh chat must still get its first analysis. */
        if (storyData._initialized && !storyData._lastTurn) {
            var seed = stTurnStamp();
            if (seed) storyData._lastTurn = seed;
        }
    } else {
        storyData = makeDefaultData();
        if (meta) meta[DATA_KEY] = storyData;
        msgCounter = 0;
    }
}

function saveStoryData() {
    if (!scriptModule || !scriptModule.chat_metadata) return;
    storyData._msgCount = msgCounter;
    scriptModule.chat_metadata[DATA_KEY] = storyData;
    if (typeof scriptModule.saveMetadataDebounced === "function") scriptModule.saveMetadataDebounced();
}

// Fills the settings dropdown with available connection profiles.
function populateProfileDropdown() {
    var $sel = $("#st-s-profile");
    if (!$sel.length) return;
    var profiles = getProfileList();
    var html = '<option value="">— Use current / main profile —</option>';
    if (profiles.length === 0) {
        html += '<option value="" disabled>(No profiles found — install/enable Connection Profiles)</option>';
    } else {
        profiles.forEach(function (p) {
            var name = p && p.name ? p.name : "";
            if (!name) return;
            html += '<option value="' + esc(name) + '">' + esc(name) + '</option>';
        });
    }
    $sel.html(html);
    // Restore the saved selection if it still exists.
    var saved = settings.connectionProfile || "";
    if (saved && profiles.some(function (p) { return p.name === saved; })) {
        $sel.val(saved);
    } else if (saved && profiles.length > 0) {
        // Saved profile no longer exists — keep the value so the user notices, but fall back visually.
        $sel.val("");
    }
}


// --- LLM Logic ---
/* Names of the cards actually in this chat: the solo character, or every member
   of the group. Location and narrator cards are left out — Character Creator
   saves those as cards too, and a place is not one of the people in the room. */
function knownCardNames() {
    var out = [];
    try {
        var ctx = (typeof SillyTavern !== "undefined" && SillyTavern.getContext) ? SillyTavern.getContext() : null;
        if (!ctx) return out;
        function kindOf(card) {
            var d = (card && card.data) ? card.data : (card || {});
            var ext = (d.extensions && d.extensions.character_creator) ||
                (card && card.extensions && card.extensions.character_creator);
            if (!ext) return "character";
            var data = ext.data || ext;
            var t = data && data.cardType;
            return (t === "location" || t === "narrator") ? t : "character";
        }
        function push(c) {
            if (c && c.name && kindOf(c) === "character" && out.indexOf(c.name) < 0) out.push(c.name);
        }
        if (ctx.groupId && Array.isArray(ctx.groups)) {
            var g = ctx.groups.find(function (x) { return x.id === ctx.groupId; });
            if (g && Array.isArray(g.members) && Array.isArray(ctx.characters)) {
                g.members.forEach(function (mid) {
                    push(ctx.characters.find(function (c) { return c.avatar === mid; }));
                });
            }
        } else if (ctx.characterId !== undefined && ctx.characters && ctx.characters[ctx.characterId]) {
            push(ctx.characters[ctx.characterId]);
        }
    } catch (e) { }
    return out;
}

/* Fills the Visualize preset dropdown from AutoIllustrator. A preset that
   cannot draw (no workflow and no Gemini) is listed but marked, rather than
   hidden: "my preset vanished" is a worse message than "my preset is not
   usable yet". */
function populateVizPresetDropdown() {
    var $sel = $("#st-s-viz-preset");
    if (!$sel.length) return;
    var api = (typeof window !== "undefined") ? window.AutoIllustrator : null;
    var list = (api && typeof api.getPresets === "function") ? api.getPresets() : [];
    var html = '<option value="">— Active preset —</option>';
    if (!list.length) html += '<option value="" disabled>(AutoIllustrator not loaded yet)</option>';
    list.forEach(function (p) {
        html += '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.usable ? "" : " (not usable)") + "</option>";
    });
    $sel.html(html).val(settings.vizPreset || "");
}

function buildPrevStateText() {
    if (!storyData || !storyData._initialized) return "This is the INITIAL setup. Deduce starting parameters from the intro message.";
    let s = "PREVIOUS STATE:\nTime: " + storyData.time + " | Date: " + storyData.date + " | Location: " + (storyData._origLocation || storyData.location) + "\n";
    s += "City: " + (storyData._origCity || storyData.city || "Unknown") + " | Country/Realm: " + (storyData._origCountry || storyData.country || "Unknown") + "\n";
    s += "Temperature: " + (storyData._origTemperature || storyData.temperature || "Unknown") + " | Weather: " + (storyData._origWeather || storyData.weather || "Unknown") + "\n";
    // Include current outfit from Inventory so the LLM never forgets what is worn
    var outfit = getInventoryOutfit();
    if (outfit && outfit.userEquipped.length > 0) {
        var outfitStr = outfit.userEquipped.map(function(it) { return it.label + ": " + it.name; }).join(", ");
        s += "User's current outfit: " + outfitStr + "\n";
    }
    if (outfit && outfit.charItems.length > 0) {
        var charHeld = outfit.charItems.map(function(ci) { return ci.name + " (held by " + ci.heldBy + ")"; }).join(", ");
        s += "Items held by character: " + charHeld + "\n";
    }

    var prevCustom = (storyData._origCustom || storyData.custom);
    if (prevCustom && Object.keys(prevCustom).length > 0 && settings.customFields && settings.customFields.length > 0) {
        s += "Previous custom tracked values: " + JSON.stringify(prevCustom) + "\n";
    }

    /* CONTINUITY OF IDENTITY.
       Everything else here carried over between turns — time, weather, outfit,
       custom fields — but the cast did not: the roster was re-derived from
       scratch every turn with nothing to tie it to the previous one. So when
       the story finally named the person it had been calling "the secretary",
       the next pass had no way to know it was her, and the tracker ended up
       holding two people where there was one. (Story Predictor makes this
       visible rather than causing it: it offers a card for the newly named
       NPC, and the duplicate is then staring at you from the panel.)
       Two lists, because they answer different questions: who WE were tracking,
       and who has a card — a card name is the spelling everything else in the
       stack keys on. */
    var prevChars = (storyData._origCharacters || storyData.characters || [])
        .map(function (c) { return c && c.name; })
        .filter(Boolean);
    if (prevChars.length) {
        s += "Characters tracked last turn (some may be named by ROLE, not by name): " + prevChars.join(", ") + "\n";
    }
    var cards = knownCardNames();
    if (cards.length) {
        s += "KNOWN CHARACTER CARDS (use these spellings): " + cards.join(", ") + "\n";
    }

    return s + "(Update the time, check if location/weather changed, update character positions based on what they just did. If someone tracked by role now has a name, keep ONE entry under the name.)";
}

// --- Connection Profile Support ---
// Returns the array of saved connection profiles, or [] if Connection Manager isn't active.
function getProfileList() {
    try {
        var cm = extSettings && extSettings.connectionManager;
        if (!cm || !Array.isArray(cm.profiles)) return [];
        return cm.profiles;
    } catch (e) { return []; }
}

// Returns the name of the currently selected connection profile, or "" if none/unavailable.
function getCurrentProfileName() {
    try {
        var cm = extSettings && extSettings.connectionManager;
        if (!cm) return "";
        var sel = cm.selectedProfile;
        if (!sel) return "";
        var found = (cm.profiles || []).find(function (p) { return p.id === sel; });
        return found ? (found.name || "") : "";
    } catch (e) { return ""; }
}

// True only if we actually can and should route analysis through a different profile.
function shouldSwitchProfile() {
    if (!settings.useConnectionProfile) return false;
    if (!runSlash) return false;                       // slash runner not available
    var target = (settings.connectionProfile || "").trim();
    if (!target) return false;                         // no target chosen -> use main profile
    if (getProfileList().length === 0) return false;   // Connection Manager not installed/enabled
    var current = getCurrentProfileName();
    if (current && current === target) return false;   // already on the target -> nothing to do
    return true;
}

// Switch to a named profile via the official slash command and wait for it to settle.
async function switchProfile(name) {
    if (!runSlash || !name) return false;
    try {
        // Quote the name so profiles with spaces work correctly.
        await runSlash('/profile "' + String(name).replace(/"/g, '\\"') + '"');
        // Small settle delay: switching a profile updates API/model/preset asynchronously.
        await new Promise(function (r) { setTimeout(r, 150); });
        return true;
    } catch (e) {
        console.warn("[Story Tracker] Failed to switch to profile '" + name + "':", e);
        return false;
    }
}

// Run an async LLM task on the configured profile, then always restore the original profile.
// If switching isn't needed/possible, the task simply runs on the current (main) profile.
async function withConnectionProfile(task) {
    if (!shouldSwitchProfile()) {
        return await task();
    }
    var original = getCurrentProfileName();
    var target = (settings.connectionProfile || "").trim();
    var switched = false;
    try {
        switched = await switchProfile(target);
        if (!switched) console.warn("[Story Tracker] Profile switch failed; running analysis on current profile.");
        // Persist which profile we must return to, in case the page reloads mid-analysis
        // (the finally block below would not run in that scenario).
        if (switched && original && original !== target) {
            settings._restoreProfile = original;
            save();
        }
        return await task();
    } finally {
        // Always restore the user's main profile so the chat generation is never affected.
        if (switched && original && original !== target) {
            await switchProfile(original);
        }
        // Clear the recovery marker — restoration (or the attempt) is done.
        if (settings._restoreProfile) { settings._restoreProfile = ""; save(); }
    }
}

// Safety net: if a previous analysis was interrupted (e.g. page reload) while on the
// tracker's profile, the marker survives in settings. On load, quietly switch back.
async function recoverProfileIfNeeded() {
    var pending = settings._restoreProfile;
    if (!pending || !runSlash) return;
    try {
        var current = getCurrentProfileName();
        if (current !== pending && getProfileList().some(function (p) { return p.name === pending; })) {
            console.log("[Story Tracker] Recovering interrupted profile switch → restoring '" + pending + "'.");
            await switchProfile(pending);
        }
    } catch (e) {
        console.warn("[Story Tracker] Profile recovery failed:", e);
    } finally {
        settings._restoreProfile = ""; save();
    }
}


/* Does a host already own this turn's scene? True only when the Game Shell is
   up AND the active mode's turn contract carries `scene_state` — that is the
   exact condition under which the Shell asks the main generation for the scene
   and hands it here through StoryTrackerAPI.applyScene. Reads facts the
   conductor already publishes; introduces no flag of its own (§6.3). */
function stHostDrivesScene() {
    try {
        if (typeof window === "undefined" || !window.RPGShellOpen) return false;
        var M = window.ShellModes;
        if (!M || typeof M.turnFields !== "function") return false;
        var f = M.turnFields();
        return Array.isArray(f) && f.indexOf("scene_state") !== -1;
    } catch (e) { return false; }
}

/* K1 (Academy, CONCEPT-academy-mode.md §2.4): does a host own the game CLOCK?
   True when the Shell is up and the active mode's turn contract carries
   `clock` — the academy clock then mirrors its time in through
   applyScene({time}), and this pass must not overwrite it with its own
   analysis (that would be the two-writers-of-time bug, §6.5).
   A FIELD gate, not a return gate: under the vn chassis this pass is the only
   scene tracker, so weather, positions, city/country and the rest stay live —
   only the `time` assignment steps aside. */
function stHostDrivesTime() {
    try {
        if (typeof window === "undefined" || !window.RPGShellOpen) return false;
        var M = window.ShellModes;
        if (!M || typeof M.turnFields !== "function") return false;
        var f = M.turnFields();
        return Array.isArray(f) && f.indexOf("clock") !== -1;
    } catch (e) { return false; }
}

/* W12 (Lore World): does the WORLD keep the time of this chat? Lore World runs
   one clock per world, shared by every chat set in it, and hands the three
   fields out through `LoreWorld.time.forTracker()` — which answers null when
   no such clock leads here (none started, its bridge switched off, or a
   campaign clock owns the chat instead, in which case stHostDrivesTime above
   is the gate that applies).
   The gate and the source are ONE call on purpose: asking "does it lead?" and
   then reading the hour somewhere else is how two answers get to disagree.
   Like the K1 gate this is a FIELD gate — weather, positions, place and the
   rest of the analysis stay live; only what the clock owns steps aside. */
function stWorldClock() {
    try {
        var W = (typeof window !== "undefined") ? window.LoreWorld : null;
        if (!W || !W.time || typeof W.time.forTracker !== "function") return null;
        var t = W.time.forTracker();
        return (t && typeof t === "object" && t.time) ? t : null;
    } catch (e) { return null; }
}

/* v1.16.0 — Character Library's Turn Bus (integrated turn). True only when
   the bus exists AND is switched on; asking costs nothing otherwise. */
function stBusActive() {
    try { var b = window.CLTurnBus; return !!(b && typeof b.active === "function" && b.active("story_tracker")); } catch (e) { return false; }
}

/* The automatic pass asks the bus first. A string back is THIS task's JSON
   ('' = the chat changed while it waited: apply nothing); null = run the
   classic request, which is `own`. */
async function stBusQuiet(prompt, own) {
    if (stBusActive()) {
        var r = null;
        try { r = await window.CLTurnBus.ask("story_tracker_scene", prompt, { tokens: 500 }); } catch (e) { r = null; }
        if (typeof r === "string") return r;
    }
    return await own();
}

/* opts.auto — the turn-driven pass (handleMsg). Only it may go through the
   Turn Bus; the Update button and the first-message setup stay direct. */
async function doLLMUpdate(opts) {
    if (!genQuiet) throw new Error("LLM generation not available.");
    var auto = !!(opts && opts.auto);

    // Untranslate before sending to LLM for context accuracy
    let wasTr = storyData._translated;
    if (wasTr) untranslateData();

    // Snapshot BEFORE applying the new analysis — the scene-change broadcast
    // compares old vs new location/date (untranslated values on both sides).
    var prevScene = {
        initialized: !!storyData._initialized,
        location: storyData.location,
        date: storyData.date
    };

    var prompt = buildUpdatePrompt().replace("{{PREVIOUS_STATE}}", buildPrevStateText());

    console.log("[Story Tracker] Analyzing scene...");
    // Route the scene analysis through the configured connection profile (if any),
    // then automatically restore the user's main profile when done.
    var ownCall = function () { return withConnectionProfile(function () { return genQuiet({ quietPrompt: prompt }); }); };
    var raw = auto ? await stBusQuiet(prompt, ownCall) : await ownCall();
    if (raw === "") {   /* Turn Bus: abandoned on a chat change — nothing to apply */
        if (wasTr) await translateData();
        return;
    }

    // Parse JSON safely
    var data = null;
    try { data = JSON.parse(raw); } 
    catch(e) {
        var m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { data = JSON.parse(m[0]); } catch(ex){} }
    }
    
    if (!data || !data.time) throw new Error("Failed to parse LLM response.");

    // Apply data
    /* K1: when a host clock owns the time (academy mode), the analysis keeps
       every other field but must not overwrite the mirrored time string. */
    /* W12: a world clock owns time AND date AND weekday — read from it at the
       moment this pass would have written its own guess (the analysis took a
       while; the clock did not wait for it). */
    var worldClock = stWorldClock();
    if (worldClock) {
        storyData.time = String(worldClock.time);
        if (worldClock.date) storyData.date = String(worldClock.date);
    } else {
        if (!stHostDrivesTime()) storyData.time = data.time || storyData.time;
        storyData.date = data.date || storyData.date;
    }
    storyData.location = data.location || storyData.location;

    // City / country: treat "Unknown" (case-insensitive) as missing — will trigger fallback below
    let isBlank = v => !v || v.trim().toLowerCase() === "unknown" || v.trim() === "";
    storyData.city    = !isBlank(data.city)    ? data.city    : (isBlank(storyData.city)    ? null : storyData.city);
    storyData.country = !isBlank(data.country) ? data.country : (isBlank(storyData.country) ? null : storyData.country);

    // Day of week is now mandatory from the model (same "never Unknown" contract as
    // city/country). No second fallback call, though: unlike an invented place name,
    // a missing weekday can be recovered for free from the date client-side below.
    if (worldClock && worldClock.day_of_week) storyData.day_of_week = String(worldClock.day_of_week);
    else storyData.day_of_week = !isBlank(data.day_of_week) ? data.day_of_week : (isBlank(storyData.day_of_week) ? null : storyData.day_of_week);

    storyData.temperature = data.temperature || storyData.temperature;
    storyData.weather = data.weather || storyData.weather;
    storyData.characters = Array.isArray(data.characters) ? data.characters : [];
    storyData.recent_events = data.recent_events || "";
    storyData.custom = (data.custom && typeof data.custom === "object") ? data.custom : {};
    storyData._initialized = true;

    /* Fallback: if city or country is still missing, ask the LLM for them —
       ONCE PER LOCATION.
       Reported 2026-08-02 as "two identical LLM calls per update". It was not a
       double event (that was fixed by binding one) — doLLMUpdate itself makes a
       SECOND call here, and in an invented world it made it forever: a fictional
       street has no real city, the model keeps answering "Unknown", the blank
       test keeps passing, and the next update asks the very same question about
       the very same place. A negative answer has to be REMEMBERED, or a retry
       loop with no exit is what "just a fallback" turns into.
       The memo rides in storyData (chat metadata), so it survives a reload; a
       genuine move produces a different key and asks again exactly once. */
    var ccKey = String(storyData._origLocation || storyData.location || "Unknown");
    if (settings.showCityCountry && (isBlank(storyData.city) || isBlank(storyData.country))
        && storyData._ccAsked !== ccKey) {
        storyData._ccAsked = ccKey;
        try {
            console.log("[Story Tracker] City/country missing — running fallback inference...");
            var ccPrompt = CITY_COUNTRY_PROMPT.replace("{{LOCATION}}", ccKey);
            var ccRaw = await withConnectionProfile(function () { return genQuiet({ quietPrompt: ccPrompt }); });
            var ccData = null;
            try { ccData = JSON.parse(ccRaw); }
            catch(e) { var cm = ccRaw.match(/\{[\s\S]*?\}/); if (cm) { try { ccData = JSON.parse(cm[0]); } catch(ex){} } }
            if (ccData) {
                if (!isBlank(ccData.city))    storyData.city    = ccData.city;
                if (!isBlank(ccData.country)) storyData.country = ccData.country;
            }
        } catch(fe) { console.warn("[Story Tracker] City/country fallback failed:", fe); }
    }

    // Ensure display-safe values
    if (isBlank(storyData.city))    storyData.city    = "Unknown";
    if (isBlank(storyData.country)) storyData.country = "Unknown";
    // Day of week: model output wins; if it's still missing (old save, or a model
    // that ignored the instruction), derive it from the date instead of showing
    // "Unknown" — only a date that itself can't be parsed falls through to that.
    if (isBlank(storyData.day_of_week)) storyData.day_of_week = getDayOfWeek(storyData.date) || "Unknown";

    // Save to history (keep last 20)
    storyData.history.unshift({
        msg: msgCounter,
        time: storyData.time,
        loc: storyData.location,
        temperature: storyData.temperature,
        weather: storyData.weather,
        events: storyData.recent_events,
        chars: JSON.parse(JSON.stringify(storyData.characters)),
        custom: JSON.parse(JSON.stringify(storyData.custom || {}))
    });
    if (storyData.history.length > 20) storyData.history.pop();

    saveStoryData();
    syncToCharTracker(); // Sync data with Character Tracker

    // Broadcast while the data is still untranslated, so listeners get the
    // same strings the lorebooks use.
    maybeEmitSceneChange(prevScene);

    if (wasTr) await translateData();
}

// Emits ST_SCENE_EVENT when an analysis shows the scene moved (location
// changed → 'scene') or time jumped (date changed → 'timeskip').
// messageIndex is the index at DETECTION time: the tracker notices a change
// after the fact, so this is an upper bound for the finished scene, not an
// exact boundary. Listeners treat it as the top of their sync window.
function maybeEmitSceneChange(prev) {
    try {
        if (!settings.broadcastScene) return;
        if (window._laOwnGeneration) return;   // never react to Lore Atlas' own quiet prompts
        if (!prev.initialized) return;         // first analysis of a chat is setup, not a change
        var known = function (v) { return v && String(v).trim() && String(v).trim().toLowerCase() !== "unknown"; };
        var newLoc = storyData.location, newDate = storyData.date;
        var locChanged = known(prev.location) && known(newLoc) && prev.location.trim().toLowerCase() !== newLoc.trim().toLowerCase();
        var dateChanged = known(prev.date) && known(newDate) && prev.date.trim() !== newDate.trim();
        if (!locChanged && !dateChanged) return;

        var ctx = SillyTavern.getContext();
        var chatId = String((ctx.getCurrentChatId && ctx.getCurrentChatId()) || "");
        var idx = (scriptModule.chat ? scriptModule.chat.length : 0) - 1;
        if (!chatId || idx < 0) return;
        if (lastSceneEmit.chatId === chatId && lastSceneEmit.idx === idx) return;  // dedup
        lastSceneEmit = { chatId: chatId, idx: idx };

        var payload = {
            version: 1,
            source: "story-tracker",
            reason: locChanged ? "scene" : "timeskip",
            chatId: chatId,
            messageIndex: idx,
            scene: {
                location: known(newLoc) ? newLoc : "",
                locationPath: [storyData.country, storyData.city, newLoc].filter(known),
                participants: (storyData.characters || []).map(function (c) { return c && c.name; }).filter(Boolean),
                summary: storyData.recent_events || "",
                deltaLines: []
            }
        };
        ctx.eventSource.emit(ST_SCENE_EVENT, payload);
        console.log("[Story Tracker] Scene change broadcast:", payload.reason, payload.scene.location);
    } catch (e) { console.warn("[Story Tracker] Scene broadcast failed:", e); }
}

// --- Sync to Character Tracker ---
function syncToCharTracker() {
    try {
        var meta = scriptModule ? scriptModule.chat_metadata : null;
        if (!meta) return;
        var ct = meta["char_tracker"];
        if (!ct) return; // Character Tracker not yet initialized

        // Parse date from "DD/MM/YYYY" format
        var day = 1, month = 1, year = 2024;
        var parts = (storyData.date || "").split(/[\/\-\.]/);
        if (parts.length >= 3) {
            day   = parseInt(parts[0], 10) || 1;
            month = parseInt(parts[1], 10) || 1;
            year  = parseInt(parts[2], 10) || 2024;
        }

        // Update sharedTime
        var container = ct._isGroup ? ct : ct;
        if (!container.sharedTime) container.sharedTime = {};
        container.sharedTime.time  = storyData.time  || "--:--";
        container.sharedTime.day   = day;
        container.sharedTime.month = month;
        container.sharedTime.year  = year;
        container._timeInitialized = true;

        // Update location
        if (ct._isGroup) {
            var activeChar = ct._activeChar;
            if (activeChar && ct.characters && ct.characters[activeChar]) {
                ct.characters[activeChar].location = storyData.location;
            }
        } else {
            ct.location = storyData.location;
        }

        if (typeof scriptModule.saveMetadataDebounced === "function")
            scriptModule.saveMetadataDebounced();

        console.log("[Story Tracker] Synced time/location → Character Tracker");
		$(document).trigger("CT_FORCE_RENDER");
    } catch(e) { console.error("[Story Tracker] syncToCharTracker error:", e); }
}

// --- Inventory Integration ---
var INV_SLOTS        = ["head","torso","legs","feet","hands","lefthand","righthand","accessory1","accessory2"];
var INV_SLOT_LABELS  = { head:"Head", torso:"Torso", legs:"Legs", feet:"Feet", hands:"Hands", lefthand:"Left Hand", righthand:"Right Hand", accessory1:"Accessory 1", accessory2:"Accessory 2" };
var INV_SLOT_ICONS   = { head:"🎩", torso:"👕", legs:"👖", feet:"👟", hands:"🧤", lefthand:"🤚", righthand:"✋", accessory1:"💍", accessory2:"💍" };

function getInventoryOutfit() {
    try {
        var meta = scriptModule ? scriptModule.chat_metadata : null;
        if (!meta) return null;
        var inv = meta["inv_data"];
        if (!inv || !inv.equipped) return null;

        // Use original (untranslated) names when available for LLM injection
        var eq = (inv._translated && inv._orig) ? inv._orig.equipped : inv.equipped;

        var userEquipped = [];
        for (var i = 0; i < INV_SLOTS.length; i++) {
            var sl = INV_SLOTS[i];
            var it = eq[sl];
            if (it && !it._mirror) {
                userEquipped.push({
                    slot:  sl,
                    label: INV_SLOT_LABELS[sl],
                    icon:  INV_SLOT_ICONS[sl],
                    name:  it.name || "?",
                    description: it.description || ""
                });
            }
        }

        // Items currently held by the AI character
        var charItems = (inv.charItems || []).map(function(ci) {
            return { name: ci.name, heldBy: ci.heldBy || "Character" };
        });

        return { userEquipped: userEquipped, charItems: charItems };
    } catch (e) {
        console.error("[Story Tracker] getInventoryOutfit error:", e);
        return null;
    }
}

/* ── ONE owner of the Inventory tail ──
   "…, wearing X" / "…, holding Y" was written out twice — once in renderHUD,
   once in renderModal — and Visualize would have made it three. The tail is
   not decoration: it is part of what the character IS this turn, so the
   drawing and both panels have to agree on it or the picture shows clothes
   the panel does not. `name` is the ORIGINAL (untranslated) name — the same
   spelling Inventory keys on. */
function stIsUserName(name) {
    var userName = (scriptModule && scriptModule.name1) ? scriptModule.name1 : null;
    var n = String(name || "").toLowerCase();
    return (!!userName && n === userName.toLowerCase()) || n === "user" || n === "вы" || name === "{{user}}";
}
/* Pure (v1.14.0). Which tracked character a name means: exact (case-insensitive)
   in any of the given lists first, then one whose first word is the asked name's
   first word — "Carmilla" and "Carmilla Schmidt" — but only when exactly one
   character fits. -1 when nobody does. */
function stFindCharIndex(lists, name) {
    var want = String(name || "").trim().toLowerCase();
    if (!want) return -1;
    var i, j, L;
    for (j = 0; j < lists.length; j++) {
        L = lists[j] || [];
        for (i = 0; i < L.length; i++) if (L[i] && String(L[i].name || "").trim().toLowerCase() === want) return i;
    }
    var first = want.split(/\s+/)[0], hits = {};
    for (j = 0; j < lists.length; j++) {
        L = lists[j] || [];
        for (i = 0; i < L.length; i++) {
            var n = String((L[i] && L[i].name) || "").trim().toLowerCase();
            if (n && n.split(/\s+/)[0] === first) hits[i] = 1;
        }
    }
    var keys = Object.keys(hits);
    return keys.length === 1 ? Number(keys[0]) : -1;
}

function stOutfitTail(name) {
    var outfit = getInventoryOutfit();
    if (!outfit) return "";
    var tail = "";
    if (outfit.userEquipped.length > 0 && stIsUserName(name)) {
        tail += ", wearing " + outfit.userEquipped.map(function (it) { return it.name; }).join(", ");
    }
    if (outfit.charItems.length > 0) {
        var held = outfit.charItems.filter(function (ci) {
            return ci.heldBy && ci.heldBy.toLowerCase() === String(name || "").toLowerCase();
        });
        if (held.length > 0) tail += ", holding " + held.map(function (ci) { return ci.name; }).join(", ");
    }
    return tail;
}

// --- Context Injection ---
var ST_INJECT_KEY = "STORY_TRACKER_SCENE";
function stInjectPos() { return (scriptModule && scriptModule.extension_prompt_types) ? scriptModule.extension_prompt_types.IN_CHAT : 1; }
function stSetInject(text) { try { if (scriptModule && typeof scriptModule.setExtensionPrompt === "function") scriptModule.setExtensionPrompt(ST_INJECT_KEY, text, stInjectPos(), 1, false); } catch (e) { console.error("[Story Tracker] Inject error:", e); } }

function injectContextToChat() {
    if (!settings.enabled || !settings.injectToContext || !storyData || !storyData._initialized) { stSetInject(""); return; }
    /* Game Shell §10 C4: while the Shell speaks for the ecosystem, its state
       digest (ZZ_GM_STATE) already carries every field this block prints —
       location, time, weather, positions, recent events, outfit, custom
       parameters — so injecting them again is the same facts twice.
       WE STILL COMPUTE THE SCENE: only the injection goes quiet. The digest
       reads it through StoryTrackerAPI.getScene(), so muting the calculation
       would blank the very thing that replaced us. The flag is lowered the
       moment the Shell closes, and standalone use is untouched. */
    if (typeof window !== "undefined" && window.RPGShellOwnsContext) { stSetInject(""); return; }
    
    // Always inject original (untranslated) data to LLM
    let loc = storyData._origLocation || storyData.location;
    let ev = storyData._origEvents || storyData.recent_events;
    
    let charsText = "";
    if (storyData.characters && storyData.characters.length > 0) {
        let origChars = storyData._origCharacters || storyData.characters;
        charsText = origChars.map(c => `${c.name}: ${c.state}`).join(" | ");
    }

    let cityCountryStr = "";
    if (settings.showCityCountry) {
        let city = storyData._origCity || storyData.city || "";
        let country = storyData._origCountry || storyData.country || "";
        if (city && city !== "Unknown" || country && country !== "Unknown") {
            cityCountryStr = "\nCity: " + (city || "Unknown") + " | Country/Realm: " + (country || "Unknown");
        }
    }

    let inj = `[Scene Context: Time: ${storyData.time}, Date: ${storyData.date}\nLocation: ${loc}${cityCountryStr}\nTemperature: ${storyData._origTemperature || storyData.temperature || "Unknown"} | Weather: ${storyData._origWeather || storyData.weather || "Unknown"}\nPositions: ${charsText}\nRecent: ${ev}`;

    // Append outfit from Inventory if available
    var outfit = getInventoryOutfit();
    if (outfit && outfit.userEquipped.length > 0) {
        var outfitStr = outfit.userEquipped.map(function(it) { return it.label + ": " + it.name; }).join(", ");
        inj += `\nUser's Outfit: ${outfitStr}`;
    }
    if (outfit && outfit.charItems.length > 0) {
        var charHeldStr = outfit.charItems.map(function(ci) { return ci.name + " (held by " + ci.heldBy + ")"; }).join(", ");
        inj += `\nCharacter holds: ${charHeldStr}`;
    }

    // Append custom tracked parameters (e.g. emotional state, growth level), if any are configured
    if (settings.customFields && settings.customFields.length > 0) {
        var origCustom = storyData._origCustom || storyData.custom;
        if (origCustom && Object.keys(origCustom).length > 0) {
            var fieldLabels = {};
            settings.customFields.forEach(function (f) { fieldLabels[f.id] = f.label; });
            var customLines = [];
            for (var charName in origCustom) {
                var vals = origCustom[charName];
                if (!vals || typeof vals !== "object") continue;
                var parts = Object.keys(vals).map(function (k) { return (fieldLabels[k] || k) + ": " + vals[k]; });
                if (parts.length > 0) customLines.push(charName + " — " + parts.join(", "));
            }
            if (customLines.length > 0) inj += `\nTracked Parameters: ${customLines.join(" | ")}`;
        }
    }

    inj += `]`;
    
    // Inject via the proper extension-prompt channel. The old build wrote into
    // chat_metadata.authorsNote — a key SillyTavern never reads (the author's note
    // lives in note_prompt), so the tracked scene context never reached the model.
    var mk = "<!-- ST_INJECT -->", emk = "<!-- /ST_INJECT -->";
    stSetInject(mk + "\n" + inj + "\n" + emk);
}

/* Identity of the turn currently at the end of the chat.
   SillyTavern REPLAYS the opening turn on every load: getChatResult() in
   script.js emits MESSAGE_RECEIVED + CHARACTER_MESSAGE_RENDERED('first_message')
   whenever the chat holds exactly ONE message — the condition is
   `chat.length === 1`, not "the chat was just created". So reopening an
   untouched new chat is indistinguishable, from the handler's side, from a
   fresh turn arriving: msgCounter crept up one per reload and every third open
   spent a full paid analysis re-deducing a scene whose answer was already
   sitting in chat metadata.
   The guard therefore owns its OWN state — the identity of the last turn it
   processed — and not the event or the phase (§6.1). Index alone would not do:
   a swipe or a regeneration replaces the text at the SAME index and is a real
   new turn, so the text is fingerprinted too. The stamp lives in storyData,
   i.e. chat metadata, because the replay it has to survive is a reload. */
function stTurnStamp() {
    var chat = scriptModule ? scriptModule.chat : null;
    if (!Array.isArray(chat) || chat.length === 0) return "";
    var idx = chat.length - 1;
    var mes = String((chat[idx] && chat[idx].mes) || "");
    var h = 0;
    for (var i = 0; i < mes.length; i++) h = ((h << 5) - h + mes.charCodeAt(i)) | 0;
    return idx + ":" + mes.length + ":" + (h >>> 0).toString(36);
}

// --- Event Handling ---
function bindEvents() {
    var es = scriptModule.eventSource, et = scriptModule.event_types;
    if (!es) return;
    
    es.on(et.CHAT_CHANGED, function() {
        loadStoryData();
        renderModal(); renderHUD();
    });
    
	$(document).on("ST_FORCE_RENDER", function() {
        loadStoryData();
        renderModal(); 
        renderHUD();
    });

    // Re-render instantly when Inventory equipment changes (equip / unequip / drop)
    $(document).on("INV_EQUIPMENT_CHANGED", function() {
        renderModal();
        renderHUD();
        if (settings.enabled && settings.injectToContext) injectContextToChat();
    });

    let handleMsg = async function() {
        if (window._laOwnGeneration) return;   // Lore Atlas background prompt — not story content
        /* GM Turn (§9.1): the Game Shell already got this turn's scene out of
           the MAIN generation and applies it through StoryTrackerAPI. The flag
           is only up while a block actually arrived — a turn without one
           releases it before this handler runs, so nothing is starved. */
        if (window.RPGShellDriving) return;
        /* ...and stand down for as long as the Shell is up IF its mode actually
           carries the scene. RPGShellDriving is raised only around the Shell's
           own satellite jobs, so between turns this pass still ran a full paid
           analysis of a message the host had already analysed and applied
           through StoryTrackerAPI.applyScene — the §10 note "story-tracker goes
           quiet under the Shell" described an intention the guard never
           implemented.
           The gate is deliberately NOT "the Shell is open": the vn and pnc
           chassis DROP scene_state from the contract, so in a Visual Novel or a
           Journey this extension is the only thing tracking time and place, and
           silencing it there would take the tracking away instead of
           deduplicating it. */
        if (stHostDrivesScene()) return;
        if (!settings.enabled || busy) return;
        /* Replay guard, see stTurnStamp(): the same message rendered again is
           not a new turn. It has to sit BEFORE msgCounter++ — a counter that
           ticks on reloads drags the auto-update cadence off the messages it is
           supposed to count, so the drift outlives the reload that caused it. */
        var turnStamp = stTurnStamp();
        if (turnStamp && storyData && storyData._lastTurn === turnStamp) return;
        msgCounter++;
        if (turnStamp && storyData) storyData._lastTurn = turnStamp;
        saveStoryData();
        
        // Initial setup on 1st message, or auto-update
        let isFirstMsg = scriptModule.chat.length <= 2 && !storyData._initialized;
        
        if (isFirstMsg || (settings.autoUpdate && msgCounter % settings.autoUpdateInterval === 0)) {
            busy = true;
            /* v1.16.0: under the Turn Bus the pass waits for the batch (the
               other trackers ask a second or two later). ST awaits this
               listener, so awaiting here would hold CHARACTER_MESSAGE_RENDERED
               — and with it the end of the generation the others wait for —
               until the batch it is waiting on gave up on them. Detached, the
               busy flag still keeps the next turn from starting a second pass. */
            var run = async function () {
                try {
                    await doLLMUpdate({ auto: !isFirstMsg });
                    renderModal(); renderHUD();
                } catch(e) { console.error(e); }
                busy = false;
            };
            if (!isFirstMsg && stBusActive()) run();
            else await run();
        } else {
            renderAutoInfo();
        }
    };

    // Bind to ONE message event only. eventSource.emit awaits each handler, so
    // MESSAGE_RECEIVED's handleMsg finishes doLLMUpdate and clears `busy` BEFORE
    // CHARACTER_MESSAGE_RENDERED fires — the busy guard can't dedupe across two
    // events, so binding both ran the whole analysis twice (2 events × up to 2
    // LLM calls = 4 requests per turn).
    es.on(et.CHARACTER_MESSAGE_RENDERED, handleMsg);
    es.on(et.GENERATION_STARTED, function() { injectContextToChat(); });
}

// --- UI Rendering ---
function esc(t) { var d = document.createElement("div"); d.textContent = t; return d.innerHTML; }

function getDayOfWeek(dateStr) {
    if (!dateStr || dateStr === "Unknown") return "";
    var parts = dateStr.split(/[\/\-\.]/);
    if (parts.length < 3) return "";
    var day = parseInt(parts[0], 10), month = parseInt(parts[1], 10), year = parseInt(parts[2], 10);
    if (isNaN(day) || isNaN(month) || isNaN(year)) return "";
    var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    var d = new Date(year, month - 1, day);
    if (isNaN(d.getTime())) return "";
    return days[d.getDay()];
}

function buildModal() {
    if (document.getElementById("st-modal")) return;
    var h = '<div id="st-modal" style="display:none"><div class="st-overlay"></div><div class="st-dialog">';
    h += '<div class="st-header"><div class="st-title"><i class="fa-solid fa-book-open-reader"></i> Story Tracker</div>';
    h += '<div class="st-header-right">';
    h += '<button class="st-hdr-btn menu_button" id="st-h-atlas" title="Open current location in Lore Atlas"><i class="fa-solid fa-diagram-project"></i></button>';
    h += '<button class="st-hdr-btn menu_button" id="st-h-translate" title="Translate"><i class="fa-solid fa-language"></i></button>';
    h += '<button class="st-hdr-btn menu_button" id="st-h-refresh" title="Force Update"><i class="fa-solid fa-rotate"></i></button>';
    h += '<button class="st-hdr-btn menu_button" id="st-h-close" title="Close"><i class="fa-solid fa-xmark"></i></button>';
    h += '</div></div>';
    
    h += '<div class="st-tabs"><div class="st-tab st-tab-active" data-target="st-tab-current">Current Scene</div><div class="st-tab" data-target="st-tab-history">History / Stats</div></div>';
    
    h += '<div class="st-body">';
    h += '<div id="st-tab-current">';
    h += '<div class="st-no-data" id="st-no-data" style="display:none"><i class="fa-solid fa-hourglass-start"></i><div>Waiting for first update...</div></div>';
    h += '<div id="st-content-area">';
    h += '<div class="st-section"><div class="st-sec-title"><i class="fa-solid fa-map-location-dot"></i> Time & Place</div>';
    h += '<div class="st-grid"><div class="st-item"><div class="st-item-label">Time</div><div class="st-item-val" id="st-val-time"></div></div>';
    h += '<div class="st-item"><div class="st-item-label">Date</div><div class="st-item-val" id="st-val-date"></div></div>';
    h += '<div class="st-item" style="grid-column:1/-1"><div class="st-item-label">Day of Week</div><div class="st-item-val" id="st-val-dow"></div></div>';
    h += '<div class="st-item" style="grid-column:1/-1"><div class="st-item-label">Location</div><div class="st-item-val" id="st-val-loc"></div></div>';
    h += '<div class="st-item" style="grid-column:1/-1" id="st-city-country-row"><div class="st-item-label">City / Country</div><div class="st-item-val" id="st-val-city-country"></div></div>';
    h += '<div class="st-item"><div class="st-item-label">Temperature</div><div class="st-item-val" id="st-val-temp"></div></div>';
    h += '<div class="st-item"><div class="st-item-label">Weather</div><div class="st-item-val" id="st-val-weather"></div></div>';
    h += '</div></div>';
    
    h += '<div class="st-section"><div class="st-sec-title"><i class="fa-solid fa-users"></i> Character Positions</div><div class="st-char-list" id="st-val-chars"></div></div>';
    h += '<div class="st-section" id="st-custom-section" style="display:none"><div class="st-sec-title"><i class="fa-solid fa-sliders"></i> Custom Tracking</div><div class="st-char-list" id="st-val-custom"></div></div>';
    h += '<div class="st-section"><div class="st-sec-title"><i class="fa-solid fa-scroll"></i> Recent Events (Summary) <span id="st-viz-sum-eye"></span></div><div class="st-summary-box" id="st-val-events"></div><div id="st-viz-sum-block"></div></div>';
    h += '</div></div>'; // end tab 1
    
    h += '<div id="st-tab-history" style="display:none;"><div id="st-history-list"></div></div>';
    
    h += '</div>'; // end body
    h += '<div class="st-footer"><button class="menu_button" id="st-f-update"><i class="fa-solid fa-bolt"></i> Update Now</button><div class="st-auto-info" id="st-auto-info"></div></div>';
    h += '</div></div>';
    document.body.insertAdjacentHTML("beforeend", h);

    $(document).on("click", ".st-overlay, #st-h-close", function() { $("#st-modal").fadeOut(150); });
    $(document).on("click", "#st-h-refresh, #st-f-update", doManualUpdate);
    $(document).on("click", "#st-h-translate", doTranslateToggle);
    // Manual bridge: jump to the current location's book in Lore Atlas (if installed)
    $(document).on("click", "#st-h-atlas", function() {
        var la = window.LoreAtlas;
        if (!la) { if (typeof toastr !== "undefined") toastr.warning("Lore Atlas is not installed."); return; }
        var loc = storyData ? (storyData._origLocation || storyData.location || "") : "";
        var book = (typeof la.resolveLocation === "function") ? la.resolveLocation(loc) : null;
        $("#st-modal").fadeOut(150);
        if (book && typeof la.openBook === "function") la.openBook(book);
        else la.open();
    });
    $(document).on("click", ".st-tab", function() {
        $(".st-tab").removeClass("st-tab-active"); $(this).addClass("st-tab-active");
        $("#st-tab-current, #st-tab-history").hide();
        $("#" + $(this).data("target")).show();
    });
}

function renderModal() {
    if (!storyData) return;
    if (!storyData._initialized) {
        $("#st-no-data").show(); $("#st-content-area").hide();
    } else {
        $("#st-no-data").hide(); $("#st-content-area").show();
        $("#st-val-time").text(storyData.time);
        $("#st-val-date").text(storyData.date);
        var dow = (storyData.day_of_week && storyData.day_of_week !== "Unknown") ? storyData.day_of_week : getDayOfWeek(storyData.date);
        $("#st-val-dow").text(dow || "Unknown");
        $("#st-val-loc").text(storyData.location);
        
        // City / Country row — shown only when setting is enabled
        if (settings.showCityCountry) {
            let city = storyData.city || "Unknown";
            let country = storyData.country || "Unknown";
            let ccText = (city !== "Unknown" || country !== "Unknown")
                ? [city, country].filter(v => v && v !== "Unknown").join(", ") || "Unknown"
                : "Unknown";
            $("#st-val-city-country").text(ccText);
            $("#st-city-country-row").show();
        } else {
            $("#st-city-country-row").hide();
        }

        $("#st-val-temp").text(storyData.temperature || "Unknown");
        $("#st-val-weather").text(storyData.weather || "Unknown");
        $("#st-val-events").text(storyData.recent_events);
        $("#st-viz-sum-eye").html(stVizEyeHTML("summary", -1));
        $("#st-viz-sum-block").html(stVizBlockHTML("summary", -1));

        let cHtml = "";
        if (storyData.characters) {
            storyData.characters.forEach((c, ci) => {
                var origName = ((storyData._origCharacters || storyData.characters)[ci] || c).name;
                var stateText = c.state + stOutfitTail(origName);

                cHtml += '<div class="st-char-card"><div class="st-char-name">' + esc(c.name) + stVizEyeHTML("char", ci) + '</div>'
                       + '<div class="st-char-state">' + esc(stateText) + '</div>'
                       + stVizBlockHTML("char", ci) + '</div>';
            });
        }
        $("#st-val-chars").html(cHtml || "<i>No characters detected.</i>");

        // Custom Tracking section
        if (settings.customFields && settings.customFields.length > 0) {
            var fieldLabels = {};
            settings.customFields.forEach(function (f) { fieldLabels[f.id] = f.label; });
            var custHtml = "";
            var custData = storyData.custom || {};
            Object.keys(custData).forEach(function (charName) {
                var vals = custData[charName];
                if (!vals || typeof vals !== "object") return;
                var rows = Object.keys(vals).map(function (k) {
                    return '<div><span style="opacity:.6">' + esc(fieldLabels[k] || k) + ':</span> ' + esc(String(vals[k])) + '</div>';
                }).join("");
                /* Eye here, picture NOT here. Custom Tracking shows the SAME
                   subject as Character Positions, so rendering the thumbnail in
                   both put one picture on the screen twice. The panel gets one
                   owner of the preview — the block that carries the pose — and
                   the eye stays everywhere, because it is a verb, not a view. */
                var cIdx = stVizIdxByShownName(charName);
                if (rows) custHtml += '<div class="st-char-card"><div class="st-char-name">' + esc(charName)
                    + (cIdx >= 0 ? stVizEyeHTML("char", cIdx) : "") + '</div><div class="st-char-state">' + rows + '</div></div>';
            });
            $("#st-val-custom").html(custHtml || "<i>No data yet.</i>");
            $("#st-custom-section").show();
        } else {
            $("#st-custom-section").hide();
        }
    }   // end storyData._initialized else block
    
    // History render
    let hHtml = "";
    if (storyData.history && storyData.history.length > 0) {
        var fieldLabelsH = {};
        (settings.customFields || []).forEach(function (f) { fieldLabelsH[f.id] = f.label; });
        storyData.history.forEach((h, i) => {
            let weatherInfo = (h.temperature || h.weather) ? ` | ${h.temperature || ""}${h.weather ? " " + esc(h.weather) : ""}` : "";
            let customLine = "";
            if (h.custom && Object.keys(h.custom).length > 0 && settings.customFields && settings.customFields.length > 0) {
                let bits = [];
                Object.keys(h.custom).forEach(function (charName) {
                    var vals = h.custom[charName];
                    if (!vals || typeof vals !== "object") return;
                    var parts = Object.keys(vals).map(function (k) { return (fieldLabelsH[k] || k) + ": " + vals[k]; });
                    if (parts.length > 0) bits.push(charName + " (" + parts.join(", ") + ")");
                });
                if (bits.length > 0) customLine = `<div class="st-history-sum" style="opacity:.6;margin-top:3px;">${esc(bits.join(" | "))}</div>`;
            }
            hHtml += `<div class="st-history-item">
                <div class="st-history-meta"><span>Update at Msg #${h.msg}</span><span>${h.time} | ${esc(h.loc)}${weatherInfo}</span></div>
                <div class="st-history-sum">${esc(h.events)}</div>
                ${customLine}
            </div>`;
        });
    } else { hHtml = "<div class='st-no-data'>No history yet.</div>"; }
    $("#st-history-list").html(hHtml);

    renderAutoInfo();
    syncTranslateBtn();
}

function renderAutoInfo() {
    if(!settings.autoUpdate) { $("#st-auto-info").text("Auto-update: OFF"); return; }
    let rem = settings.autoUpdateInterval - (msgCounter % settings.autoUpdateInterval);
    $("#st-auto-info").text(`Auto-update in ${rem} msg(s)`);
}

async function doManualUpdate() {
    if (busy) return;
    busy = true;
    var $b = $("#st-f-update").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...');
    try {
        await doLLMUpdate();
        renderModal(); renderHUD();
        if(typeof toastr !== "undefined") toastr.success("Story updated!");
    } catch(e) { if(typeof toastr !== "undefined") toastr.error(e.message); }
    busy = false;
    $b.prop("disabled", false).html('<i class="fa-solid fa-bolt"></i> Update Now');
}

// --- HUD ---
function buildHUD() {
    if (document.getElementById("st-hud")) return;
    let h = `<div id="st-hud" class="st-hud st-hud-pos-${settings.hudPosition}"><div class="st-hud-head"><i class="fa-solid fa-book"></i> Tracker <span class="st-hud-tools"><i class="fa-solid fa-users st-viz-fold" id="st-hud-details"></i><i class="fa-solid fa-images st-viz-fold" id="st-viz-fold"></i><i class="fa-solid fa-chevron-up"></i></span></div><div class="st-hud-body" id="st-hud-body"></div></div>`;
    document.body.insertAdjacentHTML("beforeend", h);
    $(document).on("click", ".st-hud-head", function() { $("#st-hud").toggleClass("st-hud-collapsed"); });
    /* Same rule as the picture fold below: a button in the head must not
       let its click through, or it would fold the whole panel too. */
    $(document).on("click", "#st-hud-details", function (e) {
        e.preventDefault(); e.stopPropagation();
        settings.hudDetails = (settings.hudDetails === false);
        save();
        renderHUD();
    });
    /* The fold lives in the head, and the head folds the whole panel on click —
       so it must not let its own click through (same reason as the eye). */
    $(document).on("click", "#st-viz-fold", function (e) {
        e.preventDefault(); e.stopPropagation();
        settings.vizThumbs = (settings.vizThumbs === false);
        save();
        renderHUD();
    });
    $(document).on("click", "#st-hud-body", function() { loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); });
    renderHUD();
}

function applyHudStyle() {
    var $h = $("#st-hud");
    $h.removeClass("st-hud-pos-bottom-right st-hud-pos-bottom-left st-hud-pos-top-right st-hud-pos-top-left").addClass(`st-hud-pos-${settings.hudPosition}`);
    
    var scale = (settings.hudScale || 100) / 100;
    var origin = "bottom right";
    if (settings.hudPosition === "bottom-left") origin = "bottom left";
    if (settings.hudPosition === "top-right") origin = "top right";
    if (settings.hudPosition === "top-left") origin = "top left";

    $h.css({
        "transform": `scale(${scale})`,
        "transform-origin": origin
    });
}

function renderHUD() {
    $("#st-hud").toggle(settings.showHUD);
    applyHudStyle();
    stVizFoldSync();

    if (!storyData || !storyData._initialized) {
        $("#st-hud-body").html("<div style='text-align:center;opacity:.5;font-size:10px;'>Waiting...</div>"); return;
    }
    stVizPrune();
    let dow = (storyData.day_of_week && storyData.day_of_week !== "Unknown") ? storyData.day_of_week : getDayOfWeek(storyData.date);
    let dowStr = ` &nbsp;<i class="fa-solid fa-calendar-day"></i> ${dow || "Unknown"}`;
    let h = `<div class="st-hud-row"><i class="fa-solid fa-clock"></i> <strong>${storyData.time}</strong> &nbsp; <i class="fa-solid fa-calendar"></i> ${storyData.date}${dowStr}</div>`;
    h += `<div class="st-hud-row"><i class="fa-solid fa-location-dot"></i> ${esc(storyData.location)}</div>`;
    if (settings.showCityCountry) {
        let city = storyData.city || "";
        let country = storyData.country || "";
        let ccText = [city, country].filter(v => v && v !== "Unknown").join(", ");
        if (ccText) h += `<div class="st-hud-row"><i class="fa-solid fa-earth-europe"></i> ${esc(ccText)}</div>`;
    }
    if (storyData.temperature || storyData.weather) {
        let wIcon = "fa-cloud-sun";
        let w = (storyData.weather || "").toLowerCase();
        if (w.includes("rain") || w.includes("дожд")) wIcon = "fa-cloud-rain";
        else if (w.includes("snow") || w.includes("снег")) wIcon = "fa-snowflake";
        else if (w.includes("storm") || w.includes("гроз")) wIcon = "fa-bolt";
        else if (w.includes("fog") || w.includes("туман")) wIcon = "fa-smog";
        else if (w.includes("clear") || w.includes("ясн") || w.includes("солн")) wIcon = "fa-sun";
        else if (w.includes("cloud") || w.includes("облач")) wIcon = "fa-cloud";
        let tempStr = storyData.temperature && storyData.temperature !== "Unknown" ? `<strong>${esc(storyData.temperature)}</strong>` : "";
        let weatherStr = storyData.weather && storyData.weather !== "Unknown" ? esc(storyData.weather) : "";
        let sep = tempStr && weatherStr ? " &nbsp; " : "";
        h += `<div class="st-hud-row"><i class="fa-solid ${wIcon}"></i> ${tempStr}${sep}${weatherStr}</div>`;
    }
    var detailsShown = settings.hudDetails !== false;
    if (detailsShown) h += `<hr style="border-color:rgba(255,255,255,0.05);margin:5px 0;">`;

    if (detailsShown && storyData.characters) {
        storyData.characters.forEach((c, ci) => {
            /* The tail is the ORIGINAL name's business — Inventory keys on the
               spelling the story used, not on the translated caption. */
            var origName = ((storyData._origCharacters || storyData.characters)[ci] || c).name;
            var hudStateText = c.state + stOutfitTail(origName);

            h += '<div class="st-hud-char"><span class="st-hud-char-name">' + esc(c.name) + ':</span> '
               + esc(hudStateText) + stVizEyeHTML("char", ci) + '</div>';

            // Custom tracked fields for this character
            if (settings.customFields && settings.customFields.length > 0 && storyData.custom && storyData.custom[c.name]) {
                var fieldLabelsHud = {};
                settings.customFields.forEach(function (f) { fieldLabelsHud[f.id] = f.label; });
                var custVals = storyData.custom[c.name];
                var custParts = Object.keys(custVals).map(function (k) { return (fieldLabelsHud[k] || k) + ": " + custVals[k]; });
                if (custParts.length > 0) h += '<div class="st-hud-outfit">' + esc(custParts.join(" · ")) + stVizEyeHTML("char", ci) + '</div>';
            }

            /* One picture per SUBJECT: both eyes above lead here. Folded away
               when the player asked for a short panel (see stVizFoldSync). */
            h += stVizBlockHTML("char", ci, settings.vizThumbs === false);
        });
    }

    $("#st-hud-body").html(h);
}

// --- Chat Button ---
function buildChatButton() {
    if (!document.getElementById("st-trigger")) {
        var btn = '<div id="st-trigger" class="st-trigger interactable" title="Story Tracker"><i class="fa-solid fa-book-open-reader"></i></div>';
        var $l = $("#leftSendForm"); if ($l.length) $l.append(btn); else $("#send_form").prepend(btn);
        $(document).on("click", "#st-trigger", function() { loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); });
    }
    toggleChatButtonVisibility();
}

function toggleChatButtonVisibility() {
    var $trigger = $("#st-trigger");
    if ($trigger.length) {
        if (settings.enabled && settings.showChatButton) {
            $trigger.show();
        } else {
            $trigger.hide();
        }
    }
}

// --- Settings UI ---
function buildSettingsPanel() {
    var $c = $("#extensions_settings2"); if (!$c.length) $c = $("#extensions_settings"); if (!$c.length) return;
    var h = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b><i class="fa-solid fa-book-open-reader"></i> Story Tracker</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-on"><span>Enable Extension</span></label></div>';
    
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-hud"><span>Show HUD Widget</span></label></div>';
    h += '<div class="da-srow" id="st-pos-row"><label><small>HUD Position:</small></label><select id="st-s-pos" class="text_pole"><option value="bottom-right">Bottom Right</option><option value="bottom-left">Bottom Left</option><option value="top-right">Top Right</option><option value="top-left">Top Left</option></select></div>';
    h += '<div class="da-srow" id="st-scale-row"><label><small>HUD Scale: <span id="st-scale-val"></span>%</small></label><input type="range" id="st-s-scale" min="50" max="200" step="5"></div>';
    
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-chatbtn"><span>Show Icon in Chat Panel</span></label></div>';
    
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-auto"><span>Auto-update LLM Scene</span></label></div>';
    h += '<div class="da-srow"><label><small>Update every N msgs: <span id="st-interval-val"></span></small></label><input type="range" id="st-s-interval" min="1" max="20" step="1"></div>';
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-inject"><span>Inject Context into Prompt (Reduces Amnesia)</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-broadcast"><span>Broadcast scene changes to other extensions</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-cityctry"><span>Show City / Country (LLM infers or invents)</span></label></div>';

    // --- Visualize section (AutoIllustrator bridge) ---
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-viz"><span><i class="fa-regular fa-eye"></i> Visualize tracked entries (AutoIllustrator)</span></label></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Adds an eye to every character block and to the events summary. One click draws that subject — pose, clothes and custom fields go into a single prompt. Pictures live until that subject\'s state changes.</small></div>';
    /* PLAIN container, not a .da-srow: that class is `display:flex; flex-wrap:
       wrap` in ST's own stylesheet, so four rows dropped inside ONE of them
       become four COLUMNS and every label wraps a character at a time. Each
       row owns its .da-srow, exactly like every neighbour in this panel. */
    h += '<div id="st-viz-rows">';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-viz-bg"><span>Send the Auto Background picture as a scene reference</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-viz-refine"><span>Refine the prompt with the LLM (one extra call per click)</span></label></div>';
    h += '<div class="da-srow"><label><small>Preset:</small></label>';
    h += '<div style="display:flex;gap:5px;align-items:center;"><select id="st-s-viz-preset" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-s-viz-refresh" title="Refresh preset list" style="flex:0 0 auto;"><i class="fa-solid fa-rotate"></i></button></div></div>';
    h += '</div>';

    // --- Custom Tracking Fields section ---
    h += '<hr><div class="da-srow"><label><b><i class="fa-solid fa-sliders"></i> Custom Tracking Fields</b></label></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Define your own per-character parameters (e.g. "Emotional State", "Growth Level"). The LLM will update them alongside time/location/events every analysis.</small></div>';
    h += '<div class="da-srow" id="st-custom-fields-list"></div>';
    h += '<div class="da-srow" style="display:flex;gap:5px;align-items:center;">';
    h += '<input type="text" id="st-cf-label" class="text_pole" placeholder="Field name (e.g. Emotional State)" style="flex:1">';
    h += '</div>';
    h += '<div class="da-srow" style="display:flex;gap:5px;align-items:center;">';
    h += '<input type="text" id="st-cf-hint" class="text_pole" placeholder="Optional hint for the LLM (e.g. \'one word: happy, angry, sad...\')" style="flex:1">';
    h += '<button class="menu_button" id="st-cf-add" style="flex:0 0 auto;"><i class="fa-solid fa-plus"></i> Add</button>';
    h += '</div>';

    // --- Custom Field Presets ---
    h += '<div class="da-srow" style="margin-top:4px;"><small style="opacity:.7"><i class="fa-solid fa-box-archive"></i> Presets — save the current field set and reuse it in other chats.</small></div>';
    h += '<div class="da-srow" style="display:flex;gap:5px;align-items:center;">';
    h += '<select id="st-cf-preset" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-cf-preset-load" title="Load preset (replaces current fields)" style="flex:0 0 auto;"><i class="fa-solid fa-download"></i></button>';
    h += '<button class="menu_button" id="st-cf-preset-del" title="Delete selected preset" style="flex:0 0 auto;"><i class="fa-solid fa-trash"></i></button>';
    h += '</div>';
    h += '<div class="da-srow" style="display:flex;gap:5px;align-items:center;">';
    h += '<input type="text" id="st-cf-preset-name" class="text_pole" placeholder="Preset name (e.g. RPG Stats)" style="flex:1">';
    h += '<button class="menu_button" id="st-cf-preset-save" style="flex:0 0 auto;"><i class="fa-solid fa-floppy-disk"></i> Save</button>';
    h += '</div>';

    // --- Connection Profile section ---
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-useprofile"><span>Use a separate Connection Profile for analysis</span></label></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Run Story Tracker\'s scene analysis on a cheaper model, then switch back to your main profile automatically. Requires the built-in <b>Connection Profiles</b> extension.</small></div>';
    h += '<div class="da-srow" id="st-profile-row"><label><small>Analysis Profile:</small></label>';
    h += '<div style="display:flex;gap:5px;align-items:center;"><select id="st-s-profile" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-s-profile-refresh" title="Refresh profile list" style="flex:0 0 auto;"><i class="fa-solid fa-rotate"></i></button></div></div>';

    h += '<div class="da-srow da-srow-btns"><input type="button" class="menu_button" id="st-s-open" value="Open Tracker"></div></div></div>';
    $c.append(h);

    $("#st-s-on").prop("checked", settings.enabled).on("change", function() { 
        settings.enabled = this.checked; save(); renderHUD(); toggleChatButtonVisibility();
    });
    
    $("#st-s-hud").prop("checked", settings.showHUD).on("change", function() { 
        settings.showHUD = this.checked; save(); renderHUD(); 
        $("#st-pos-row, #st-scale-row").toggle(this.checked);
    });
    $("#st-pos-row, #st-scale-row").toggle(settings.showHUD);
    
    $("#st-s-pos").val(settings.hudPosition).on("change", function() { settings.hudPosition = this.value; save(); applyHudStyle(); });
    
    $("#st-s-scale").val(settings.hudScale).on("input", function() { 
        settings.hudScale = parseInt(this.value, 10); 
        $("#st-scale-val").text(this.value); 
        save(); 
        applyHudStyle(); 
    });
    $("#st-scale-val").text(settings.hudScale);
    
    $("#st-s-chatbtn").prop("checked", settings.showChatButton).on("change", function() {
        settings.showChatButton = this.checked; 
        save(); 
        toggleChatButtonVisibility(); 
    });
    
    $("#st-s-auto").prop("checked", settings.autoUpdate).on("change", function() { settings.autoUpdate = this.checked; save(); renderModal(); });
    $("#st-s-interval").val(settings.autoUpdateInterval).on("input", function() { settings.autoUpdateInterval = parseInt(this.value, 10); $("#st-interval-val").text(this.value); save(); renderModal(); });
    $("#st-interval-val").text(settings.autoUpdateInterval);
    
    $("#st-s-inject").prop("checked", settings.injectToContext).on("change", function() { settings.injectToContext = this.checked; save(); });
    $("#st-s-broadcast").prop("checked", settings.broadcastScene).on("change", function() { settings.broadcastScene = this.checked; save(); });
    $("#st-s-cityctry").prop("checked", settings.showCityCountry).on("change", function() { settings.showCityCountry = this.checked; save(); renderModal(); renderHUD(); });

    // --- Visualize ---
    $("#st-s-viz").prop("checked", settings.visualize).on("change", function () {
        settings.visualize = this.checked; save();
        $("#st-viz-rows").toggle(this.checked);
        renderHUD(); renderModal();
    });
    $("#st-viz-rows").toggle(!!settings.visualize);
    $("#st-s-viz-bg").prop("checked", settings.vizUseBackground).on("change", function () { settings.vizUseBackground = this.checked; save(); });
    $("#st-s-viz-refine").prop("checked", settings.vizRefine).on("change", function () { settings.vizRefine = this.checked; save(); });
    $("#st-s-viz-preset").on("change", function () { settings.vizPreset = this.value; save(); });
    $("#st-s-viz-refresh").on("click", function () { populateVizPresetDropdown(); });
    /* AutoIllustrator loads at 200, this extension at 19 — asking it for
       presets right now would always find nobody. Both doors are used: its
       ready event, and a repopulate whenever this panel is opened. */
    populateVizPresetDropdown();
    try { document.addEventListener("autoillustrator:ready", function () { populateVizPresetDropdown(); renderHUD(); renderModal(); }); } catch (e) { }
    $c.on("click", ".inline-drawer-toggle", function () { setTimeout(populateVizPresetDropdown, 0); });

    // --- Custom Tracking Fields ---
    renderCustomFieldsList();
    $("#st-cf-add").on("click", function() {
        var label = $("#st-cf-label").val().trim();
        var hint = $("#st-cf-hint").val().trim();
        if (!label) { if (typeof toastr !== "undefined") toastr.warning("Enter a field name first."); return; }
        addCustomField(label, hint);
        $("#st-cf-label").val(""); $("#st-cf-hint").val("");
    });

    // --- Custom Field Presets controls ---
    renderPresetDropdown();
    $("#st-cf-preset-save").on("click", function () {
        var name = $("#st-cf-preset-name").val().trim();
        if (!name) { if (typeof toastr !== "undefined") toastr.warning("Enter a preset name first."); return; }
        if (!settings.customFields || settings.customFields.length === 0) {
            if (typeof toastr !== "undefined") toastr.warning("No custom fields to save into a preset.");
            return;
        }
        saveCurrentAsPreset(name);
        $("#st-cf-preset-name").val("");
    });
    $("#st-cf-preset-load").on("click", function () {
        var name = $("#st-cf-preset").val();
        if (!name) { if (typeof toastr !== "undefined") toastr.warning("Select a preset to load."); return; }
        loadPreset(name);
    });
    $("#st-cf-preset-del").on("click", function () {
        var name = $("#st-cf-preset").val();
        if (!name) { if (typeof toastr !== "undefined") toastr.warning("Select a preset to delete."); return; }
        deletePreset(name);
    });

    // --- Connection Profile controls ---
    $("#st-s-useprofile").prop("checked", settings.useConnectionProfile).on("change", function() {
        settings.useConnectionProfile = this.checked;
        save();
        $("#st-profile-row").toggle(this.checked);
    });
    $("#st-profile-row").toggle(settings.useConnectionProfile);

    populateProfileDropdown();
    $("#st-s-profile").on("change", function() { settings.connectionProfile = this.value; save(); });
    $("#st-s-profile-refresh").on("click", function() {
        populateProfileDropdown();
        if (typeof toastr !== "undefined") toastr.info("Connection profile list refreshed.");
    });

    $("#st-s-open").on("click", function() { loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); });
}

// --- Custom Tracking Fields management ---
function slugifyFieldId(label) {
    var base = String(label).toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gi, "_")
        .replace(/^_+|_+$/g, "");
    if (!base) base = "field";
    var id = base, n = 1;
    var existing = (settings.customFields || []).map(function (f) { return f.id; });
    while (existing.indexOf(id) !== -1) { id = base + "_" + (++n); }
    return id;
}

function addCustomField(label, hint) {
    if (!settings.customFields) settings.customFields = [];
    settings.customFields.push({ id: slugifyFieldId(label), label: label, hint: hint || "" });
    save();
    renderCustomFieldsList();
    renderModal(); renderHUD();
}

function removeCustomField(id) {
    settings.customFields = (settings.customFields || []).filter(function (f) { return f.id !== id; });
    save();
    renderCustomFieldsList();
    renderModal(); renderHUD();
}

function renderCustomFieldsList() {
    var $list = $("#st-custom-fields-list");
    if (!$list.length) return;
    var fields = settings.customFields || [];
    if (fields.length === 0) {
        $list.html('<small style="opacity:.5">No custom fields yet — add one below.</small>');
        return;
    }
    var h = "";
    fields.forEach(function (f) {
        h += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05);">';
        h += '<div style="flex:1;"><b>' + esc(f.label) + '</b>' + (f.hint ? ' <small style="opacity:.5">— ' + esc(f.hint) + '</small>' : '') + '</div>';
        h += '<button class="menu_button st-cf-remove" data-id="' + esc(f.id) + '" title="Remove"><i class="fa-solid fa-trash"></i></button>';
        h += '</div>';
    });
    $list.html(h);
    $list.find(".st-cf-remove").on("click", function () { removeCustomField($(this).data("id")); });
}

// --- Custom Field Presets management ---
// A preset is a named snapshot of settings.customFields, stored globally so it can
// be reused across chats/scenarios (e.g. "RPG Stats", "Romance").
function renderPresetDropdown() {
    var $sel = $("#st-cf-preset");
    if (!$sel.length) return;
    var presets = settings.customFieldPresets || [];
    var prev = $sel.val();
    var html = '<option value="">— Saved presets —</option>';
    presets.forEach(function (p) {
        if (!p || !p.name) return;
        var n = (p.fields || []).length;
        html += '<option value="' + esc(p.name) + '">' + esc(p.name) + ' (' + n + ')</option>';
    });
    $sel.html(html);
    // Keep the previous selection if it still exists.
    if (prev && presets.some(function (p) { return p.name === prev; })) $sel.val(prev);
}

function saveCurrentAsPreset(name) {
    if (!settings.customFieldPresets) settings.customFieldPresets = [];
    var fields = JSON.parse(JSON.stringify(settings.customFields || []));
    var existing = settings.customFieldPresets.find(function (p) { return p.name === name; });
    if (existing) {
        existing.fields = fields;   // same name → update the preset in place
    } else {
        settings.customFieldPresets.push({ name: name, fields: fields });
    }
    save();
    renderPresetDropdown();
    $("#st-cf-preset").val(name);
    if (typeof toastr !== "undefined") toastr.success(existing ? 'Preset "' + name + '" updated.' : 'Preset "' + name + '" saved.');
}

function loadPreset(name) {
    var preset = (settings.customFieldPresets || []).find(function (p) { return p.name === name; });
    if (!preset) return;
    settings.customFields = JSON.parse(JSON.stringify(preset.fields || []));
    save();
    renderCustomFieldsList();
    renderModal(); renderHUD();
    if (typeof toastr !== "undefined") toastr.success('Loaded preset "' + name + '".');
}

function deletePreset(name) {
    settings.customFieldPresets = (settings.customFieldPresets || []).filter(function (p) { return p.name !== name; });
    save();
    renderPresetDropdown();
    $("#st-cf-preset").val("");
    if (typeof toastr !== "undefined") toastr.info('Preset "' + name + '" deleted.');
}

// --- Translation ---
async function initTranslation() {
    try {
        var tMod = await import("../../translate/index.js");
        if (typeof tMod.translate === "function") translateFn = tMod.translate;
    } catch (e) {}
}

/* ── §9.2: window.RPGLang, the ecosystem's language layer ──────────
   Used when it is there (one language knob, one shared cache, a translate call
   that can no longer come back undefined), local path kept for standalone. */
function stLangApi() {
    try { return (typeof window !== "undefined" && window.RPGLang) ? window.RPGLang : null; } catch (e) { return null; }
}

function getTargetLang() {
    var api = stLangApi();
    try { if (api && typeof api.mtTarget === "function") { var c = api.mtTarget(); if (c) return c; } } catch (e) {}
    return (extSettings && extSettings.translate && extSettings.translate.target_language) ? extSettings.translate.target_language : "ru";
}

async function tr(text) {
    if (!text || !text.trim()) return text;
    var api = stLangApi();
    if (api && typeof api.mt === "function") return await api.mt(text, { lang: getTargetLang() });
    if (!translateFn) return text;
    return await translateFn(text, getTargetLang());
}

/* A language switch must find the data in its ORIGINAL language: translateData()
   guards on _translated and would otherwise snapshot already-translated text as
   the original, losing the source language for good. */
function stBindLangSwitch() {
    var api = stLangApi();
    if (!api || typeof api.onBeforeChange !== "function") {
        /* Character Library publishes window.RPGLang at loading_order 21 —
           later than this extension — so the first attempt finds nothing. It
           fires 'rpglang:ready' when the facade exists; retry once. */
        try { document.addEventListener("rpglang:ready", function () { stBindLangSwitch(); }, { once: true }); } catch (e) {}
        return;
    }
    api.onBeforeChange(function () {
        try {
            if (storyData && storyData._translated) { untranslateData(); renderModal(); renderHUD(); syncTranslateBtn(); }
        } catch (e) { console.warn("[Story Tracker] lang switch:", e); }
    });
}

async function translateData() {
    if (!translateFn || !storyData || storyData._translated) return;
    
    storyData._origLocation = storyData.location;
    storyData._origEvents = storyData.recent_events;
    storyData._origWeather = storyData.weather;
    storyData._origDayOfWeek = storyData.day_of_week;
    storyData._origTemperature = storyData.temperature;
    storyData._origCity = storyData.city;
    storyData._origCountry = storyData.country;
    storyData._origCharacters = JSON.parse(JSON.stringify(storyData.characters));
    storyData._origHistory = JSON.parse(JSON.stringify(storyData.history));
    storyData._origCustom = JSON.parse(JSON.stringify(storyData.custom || {}));
    
    if (storyData.location) storyData.location = await tr(storyData.location);
    if (storyData.recent_events) storyData.recent_events = await tr(storyData.recent_events);
    if (storyData.weather && storyData.weather !== "Unknown") storyData.weather = await tr(storyData.weather);
    if (storyData.day_of_week && storyData.day_of_week !== "Unknown") storyData.day_of_week = await tr(storyData.day_of_week);
    if (storyData.city && storyData.city !== "Unknown") storyData.city = await tr(storyData.city);
    if (storyData.country && storyData.country !== "Unknown") storyData.country = await tr(storyData.country);
    
    if (storyData.characters) {
        for (let c of storyData.characters) {
            c.name = await tr(c.name);
            c.state = await tr(c.state);
        }
    }

    if (storyData.history) {
        for (let h of storyData.history) {
            if (h.loc) h.loc = await tr(h.loc);
            if (h.events) h.events = await tr(h.events);
        }
    }

    /* storyData.custom is keyed by character name. The HUD/modal look it up as
       storyData.custom[c.name] against the now-translated storyData.characters,
       so the keys must follow the same rename or every lookup misses and the
       custom fields section silently vanishes post-translate. _origCharacters
       was snapshotted above, before translation, so index-pairing it against
       the now-translated storyData.characters gives the old->new name map. */
    if (storyData.custom) {
        var stNameMap = {};
        if (storyData._origCharacters && storyData.characters) {
            for (let i = 0; i < storyData._origCharacters.length && i < storyData.characters.length; i++) {
                stNameMap[storyData._origCharacters[i].name] = storyData.characters[i].name;
            }
        }
        var stTranslatedCustom = {};
        for (let charName in storyData.custom) {
            let vals = storyData.custom[charName];
            if (vals && typeof vals === "object") {
                for (let key in vals) {
                    if (vals[key] && typeof vals[key] === "string") vals[key] = await tr(vals[key]);
                }
            }
            stTranslatedCustom[stNameMap[charName] || charName] = vals;
        }
        storyData.custom = stTranslatedCustom;
    }

    storyData._translated = true;
    saveStoryData();
}

function untranslateData() {
    if (!storyData || !storyData._translated) return;
    
    if (storyData._origLocation) storyData.location = storyData._origLocation;
    if (storyData._origEvents) storyData.recent_events = storyData._origEvents;
    if (storyData._origWeather) storyData.weather = storyData._origWeather;
    if (storyData._origDayOfWeek) storyData.day_of_week = storyData._origDayOfWeek;
    if (storyData._origTemperature) storyData.temperature = storyData._origTemperature;
    if (storyData._origCity) storyData.city = storyData._origCity;
    if (storyData._origCountry) storyData.country = storyData._origCountry;
    if (storyData._origCharacters) storyData.characters = JSON.parse(JSON.stringify(storyData._origCharacters));
    if (storyData._origHistory) storyData.history = JSON.parse(JSON.stringify(storyData._origHistory));
    if (storyData._origCustom) storyData.custom = JSON.parse(JSON.stringify(storyData._origCustom));
    
    delete storyData._translated; 
    delete storyData._origLocation; 
    delete storyData._origEvents; 
    delete storyData._origWeather;
    delete storyData._origDayOfWeek;
    delete storyData._origTemperature;
    delete storyData._origCity;
    delete storyData._origCountry;
    delete storyData._origCharacters;
    delete storyData._origHistory;
    delete storyData._origCustom;
    
    saveStoryData();
}

async function doTranslateToggle() {
    if (busy) return;
    if (!translateFn) { if(typeof toastr !== "undefined") toastr.warning("Translator module not loaded."); return; }
    
    busy = true;
    let $b = $("#st-h-translate").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    
    try {
        if (storyData._translated) { untranslateData(); } 
        else { await translateData(); }
        renderModal(); renderHUD();
    } catch(e) { console.error(e); }
    
    busy = false; $b.prop("disabled", false);
    syncTranslateBtn();
}

/* ═══════════════════════════════════════════════════════════════
   VISUALIZE — the eye on a tracked entry
   ───────────────────────────────────────────────────────────────
   THE ONE DECISION EVERYTHING ELSE FOLLOWS FROM: an eye stands next to every
   entry, but it does not draw the ENTRY — it draws the SUBJECT the entry
   belongs to. "Vergil: standing near the centre of the cell" and
   "Clothes: black coarse robe" are one man, not two, so they share one prompt,
   one picture and one cache slot. Four eyes on a two-character panel therefore
   cost at most two generations, not four.

   Subjects are of exactly two kinds:
     char:<name>  — pose + Inventory tail + every custom field of that name
     summary      — the Recent Events paragraph, with the cast as context

   The cache key IS the state: chat + kind + name + a hash of the very fields
   that went into the prompt. So "images live until the next state change"
   needs no expiry logic — a changed field is a different key, and an update
   that left this character alone keeps the picture (there is nothing new to
   pay for). Storage is memory only: a base64 blob in chat_metadata is re-
   serialised on every single save, which is the tax auto-background warns
   about in its own setChatBackground comment. A copy goes to the character
   gallery for anyone who wants it to outlive the session.
   ═══════════════════════════════════════════════════════════════ */

var ST_VIZ_MAX = 12;                  // cache slots; oldest evicted first
var ST_VIZ_MAX_CHAR_REFS = 3;         // leaves one of AutoIllustrator's 4 ref slots for the scene
var stVizCache = new Map();           // key -> { image, prompt, label, kind, idx }
var stVizRuns = new Map();            // key -> AbortController | null  (a run in flight)
var stVizStatusText = new Map();      // key -> last status line from the backend

function stVizApi() { return (typeof window !== "undefined") ? window.AutoIllustrator : null; }
function stVizEnabled() {
    if (!settings.enabled || !settings.visualize) return false;
    var api = stVizApi();
    if (!api || typeof api.illustrateText !== "function") return false;
    /* isReady() is the neighbour's own answer to "can I draw at all" (a preset
       with a workflow OR Gemini). An older build without it is trusted. */
    if (typeof api.isReady === "function" && !api.isReady()) return false;
    return true;
}
function stVizChatId() {
    try {
        var ctx = (typeof SillyTavern !== "undefined" && SillyTavern.getContext) ? SillyTavern.getContext() : null;
        if (!ctx) return "";
        if (ctx.chatId) return String(ctx.chatId);
        if (typeof ctx.getCurrentChatId === "function") return String(ctx.getCurrentChatId() || "");
        return "";
    } catch (e) { return ""; }
}
function stVizHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

/* Scene bits, always from the ORIGINAL (untranslated) values — the backend is
   prompted in the story's own language, exactly like injectContextToChat does.
   A translated panel must not change what gets drawn. */
function stVizPlace() {
    var bits = [];
    var loc = storyData._origLocation || storyData.location || "";
    if (loc && loc !== "Unknown") bits.push(loc);
    if (settings.showCityCountry) {
        var city = storyData._origCity || storyData.city || "";
        var country = storyData._origCountry || storyData.country || "";
        if (city && city !== "Unknown") bits.push(city);
        if (country && country !== "Unknown") bits.push(country);
    }
    return bits.join(", ");
}
/* Weather WORDS only. The temperature is a narrative fact, not a visual one:
   "16°C" tells an image backend nothing it can draw, and carrying it in the
   payload made a two-degree drift throw away a perfectly current picture. */
function stVizWeather() {
    var w = storyData._origWeather || storyData.weather || "";
    return (w && w !== "Unknown") ? w : "";
}
/* The part of the day, not a clock reading. "14:15" is not light; "in the
   afternoon" is. Same reasoning as the temperature: the key hashes exactly
   what the prompt carries, so a quarter-hour tick that changes nothing
   visible no longer costs a regeneration. */
function stVizTime() {
    var t = String(storyData.time || "");
    var m = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})/.exec(t);
    if (!m) return "";
    var h = parseInt(m[1], 10);
    if (!isFinite(h) || h < 0 || h > 23) return "";
    if (h < 5) return "late at night";
    if (h < 8) return "at dawn";
    if (h < 11) return "in the morning";
    if (h < 14) return "around midday";
    if (h < 18) return "in the afternoon";
    if (h < 21) return "in the evening";
    return "at night";
}
function stVizBlank(v) {
    var s = String(v == null ? "" : v).trim().toLowerCase();
    return s === "" || s === "unknown" || s === "n/a" || s === "-";
}

/* The subject behind a clicked eye.
   `idx` indexes storyData.characters — NOT a name — because translation
   renames characters in place and re-keys custom, while _origCharacters stays
   paired with the rendered list BY INDEX (that pairing is the same one
   translateData() builds its rename map from). Keying on the displayed name
   would break the moment the panel is translated. */
function stVizSubject(kind, idx) {
    if (!storyData || !storyData._initialized) return null;
    var orig = storyData._origCharacters || storyData.characters || [];
    var shown = storyData.characters || [];
    var custAll = storyData._origCustom || storyData.custom || {};
    var labels = {};
    (settings.customFields || []).forEach(function (f) { if (f && f.id) labels[f.id] = f.label || f.id; });

    if (kind === "char") {
        var i = parseInt(idx, 10);
        var c = orig[i];
        if (!c || !c.name) return null;
        var name = String(c.name);
        var fields = [];
        var vals = custAll[name];
        if (vals && typeof vals === "object") {
            Object.keys(vals).forEach(function (k) {
                if (stVizBlank(vals[k])) return;
                fields.push({ label: labels[k] || k, value: String(vals[k]) });
            });
        }
        var payload = {
            kind: "char", name: name,
            state: String(c.state || "") + stOutfitTail(name),
            fields: fields,
            place: stVizPlace(), weather: stVizWeather(), time: stVizTime()
        };
        return {
            kind: "char", idx: i, name: name,
            label: (shown[i] && shown[i].name) || name,
            charNames: [name], payload: payload,
            key: stVizChatId() + "|char|" + name + "|" + stVizHash(JSON.stringify(payload))
        };
    }

    if (kind === "summary") {
        var events = storyData._origEvents || storyData.recent_events || "";
        if (stVizBlank(events)) return null;
        var cast = orig.map(function (c2) {
            return { name: String(c2.name || ""), state: String(c2.state || "") + stOutfitTail(c2.name) };
        }).filter(function (c2) { return !!c2.name; });
        var payloadS = {
            kind: "summary", events: String(events), cast: cast,
            place: stVizPlace(), weather: stVizWeather(), time: stVizTime()
        };
        return {
            kind: "summary", idx: -1, name: "summary", label: "Recent Events",
            charNames: cast.map(function (c2) { return c2.name; }),
            payload: payloadS,
            key: stVizChatId() + "|summary|" + stVizHash(JSON.stringify(payloadS))
        };
    }
    return null;
}

/* The Custom Tracking section of the modal is keyed by the DISPLAYED name
   (translateData re-keys it), so it needs the index back before it can ask for
   a subject. -1 means "this block belongs to nobody we track" — no eye. */
function stVizIdxByShownName(name) {
    var shown = (storyData && storyData.characters) || [];
    for (var i = 0; i < shown.length; i++) if (shown[i] && shown[i].name === name) return i;
    return -1;
}

/* The prompt is assembled HERE, in code, from fields that are already facts.
   No LLM round-trip per click unless the user asks for one (vizRefine), and
   the part order is fixed so two clicks on the same state cannot weight the
   same facts differently.

   IT IS PROSE, AND THAT IS NOT A MATTER OF TASTE. The first build emitted the
   tracker's own shape — one labelled line per field:

       Illustration of Mistress — a single subject, only this character is shown.
       Mistress is tall figure near the staircase, arms folded, watching you.
       Setting: Grand Lobby — Hotel of the In-Between, Crossroads Haven.
       Weather: Overcast, with thin fog seeping under the main doors, 16°C.
       Time of day: 14:15.

   Measured against the live bridge: that request came back "I'm having a hard
   time fulfilling your request" — no picture. The SAME scene as one flowing
   paragraph drew in 12 seconds, and swapping the character's name changed
   nothing either way. A form with labelled rows reads to the backend as
   something to answer, not something to draw. Every other prompt in this
   stack that survives is prose; this one is now too.

   A custom field contributes its VALUE, not its label: "Clothes" is a column
   header for the panel, "black coarse robe with an embroidered barcode" is
   the thing that gets drawn. */
function stVizPrompt(p) {
    var out = [];
    if (p.kind === "char") {
        out.push(p.name + (p.state ? ", " + p.state : "") + ".");
        p.fields.forEach(function (f) {
            var v = String(f.value || "").trim();
            if (v) out.push(v.charAt(0).toUpperCase() + v.slice(1) + (/[.!?]$/.test(v) ? "" : "."));
        });
    } else {
        out.push(String(p.events || "").trim());
        if (p.cast && p.cast.length) {
            out.push(p.cast.map(function (c) { return c.name + ", " + c.state; }).join(". ") + ".");
        }
    }
    var scene = [];
    if (p.place) scene.push(p.place);
    if (p.weather) scene.push(p.weather);
    if (p.time) scene.push(p.time);
    if (scene.length) out.push(scene.join(", ") + ".");
    if (p.kind === "char") out.push("A single character in frame: only " + p.name + " is shown.");
    return out.join(" ");
}

/* base64 for a URL the neighbour handed us. currentChatBackground() may answer
   with a data URI OR with a file path (a drawn interior is a path — that is
   the whole point of not putting blobs in metadata), so both are handled and
   a failure is simply an absent reference, never a wrong one. */
async function stVizFetchB64(url) {
    try {
        var u = String(url || "");
        if (!u) return "";
        if (u.indexOf("data:") === 0) return u;
        if (u.charAt(0) !== "/" && u.indexOf("http") !== 0) u = "/" + u;
        var r = await fetch(u);
        if (!r.ok) return "";
        var blob = await r.blob();
        if (!blob || blob.size < 100) return "";
        return await new Promise(function (res) {
            var fr = new FileReader();
            fr.onloadend = function () { res(String(fr.result || "")); };
            fr.onerror = function () { res(""); };
            fr.readAsDataURL(blob);
        });
    } catch (e) { return ""; }
}

/* Reference pictures for one subject, each with the role that says what it IS.
   Avatars come only for names that really have a card in this chat
   (knownCardNames already drops location and narrator cards); a name without a
   card is drawn from the text, which is absence of data, not failure. */
async function stVizRefs(sub) {
    var refs = [], api = stVizApi();
    var cards = knownCardNames();
    var wanted = [], labelOf = {};
    (sub.charNames || []).forEach(function (n) {
        if (wanted.length >= ST_VIZ_MAX_CHAR_REFS) return;
        if (stIsUserName(n)) {
            if (wanted.indexOf("__user__") < 0) { wanted.push("__user__"); labelOf["__user__"] = n; }
            return;
        }
        if (cards.indexOf(n) >= 0 && wanted.indexOf(n) < 0) { wanted.push(n); labelOf[n] = n; }
    });
    if (wanted.length && api && typeof api.avatarsFor === "function") {
        try {
            var map = await api.avatarsFor(wanted);
            wanted.forEach(function (k) {
                if (map && map[k]) refs.push({ image: map[k], role: "character", name: labelOf[k] || k });
            });
        } catch (e) { console.warn("[Story Tracker] avatarsFor failed:", e && e.message); }
    }
    if (settings.vizUseBackground) {
        try {
            var abg = (typeof window !== "undefined") ? window.AutoBackgroundAPI : null;
            var raw = (abg && typeof abg.currentChatBackground === "function") ? abg.currentChatBackground() : "";
            var b64 = raw ? await stVizFetchB64(raw) : "";
            if (b64) refs.push({ image: b64, role: "scene", name: stVizPlace() });
        } catch (e) { console.warn("[Story Tracker] background reference failed:", e && e.message); }
    }
    return refs;
}

function stVizStore(key, rec) {
    stVizCache.set(key, rec);
    while (stVizCache.size > ST_VIZ_MAX) {
        var oldest = stVizCache.keys().next().value;
        if (oldest === undefined) break;
        stVizCache.delete(oldest);
    }
}

/* "Until the next state change" enforced by construction: anything whose key
   no longer belongs to a live subject is dropped. A subject the update did not
   touch keeps its key — and its picture. */
function stVizPrune() {
    if (!stVizCache.size || !storyData) return;
    var live = {};
    var n = (storyData._origCharacters || storyData.characters || []).length;
    for (var i = 0; i < n; i++) { var s = stVizSubject("char", i); if (s) live[s.key] = 1; }
    var sum = stVizSubject("summary", -1); if (sum) live[sum.key] = 1;
    Array.prototype.slice.call(stVizCache.keys()).forEach(function (k) {
        if (!live[k]) stVizCache.delete(k);
    });
}

async function stVizRun(sub) {
    if (!stVizEnabled() || !sub || stVizRuns.has(sub.key)) return;
    var api = stVizApi();
    var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
    stVizRuns.set(sub.key, ctrl);
    stVizStatusText.set(sub.key, "Preparing…");
    stVizRefresh();
    try {
        var refs = await stVizRefs(sub);
        var opts = {
            text: stVizPrompt(sub.payload),
            count: 1,
            skipAnalysis: !settings.vizRefine,
            personCount: sub.kind === "char" ? 1 : Math.max(1, (sub.payload.cast || []).length),
            charNames: sub.charNames,
            hasChar: (sub.charNames || []).length > 0,
            /* OUR OWN map, deliberately empty. illustrateText() without one
               calls collectAllAvatars(), which leads with the open chat's card
               — a LOCATION card in this stack — and any name miss downstream
               falls back to the first entry, so every picture would be drawn
               around a photograph of the building. Everything we do want to
               attach travels as refImages, where it carries its own role. */
            avatarMap: {},
            refImages: refs,
            mirrorToGallery: true,
            onStatus: function (t) { stVizStatusText.set(sub.key, t); stVizRefresh(); }
        };
        if (ctrl) opts.signal = ctrl.signal;
        if (settings.vizPreset) opts.presetId = settings.vizPreset;

        /* The prompt goes to the console on EVERY run, not only on failure.
           A backend that declines to draw returns the same empty answer as one
           that broke, so the only way to tell "it refused this text" from "the
           pipe is down" is to have the text. This cost us a whole round-trip
           through the player once already. */
        console.log("[Story Tracker] visualize →", sub.kind + ":" + sub.name,
            "| refs:", refs.map(function (r) { return r.role; }).join(",") || "none",
            "| refine:", !!settings.vizRefine, "\n" + opts.text);

        var parts = await api.illustrateText(opts);
        var img = parts && parts[0] && parts[0].image;
        /* Measured on the live Gemini bridge: an IDENTICAL prompt that was
           declined once drew on the next attempt. So an empty answer is not
           proof that the text is unacceptable — it can simply be the backend
           having a bad minute, and the honest advice is "try again", not
           "rewrite your scene". The prompt is in the console either way. */
        if (!img) throw new Error("The image backend returned no picture. Click the eye again to retry — the exact prompt is in the console.");
        stVizStore(sub.key, {
            image: img.indexOf("data:") === 0 ? img : ("data:image/png;base64," + img),
            prompt: (parts[0].finalPrompt || parts[0].imagePrompt || opts.text),
            label: sub.label, kind: sub.kind, idx: sub.idx
        });
    } catch (e) {
        if (e && e.name === "AbortError") {
            if (typeof toastr !== "undefined") toastr.info("Visualization cancelled.");
        } else {
            console.error("[Story Tracker] visualize:", e);
            if (typeof toastr !== "undefined") toastr.error((e && e.message) || "Visualization failed.");
        }
    } finally {
        stVizRuns.delete(sub.key);
        stVizStatusText.delete(sub.key);
        stVizRefresh();
    }
}

function stVizRefresh() { try { renderHUD(); renderModal(); } catch (e) { } }

function stVizClick(kind, idx) {
    if (!stVizEnabled()) return;
    var sub = stVizSubject(kind, idx);
    if (!sub) return;
    if (stVizRuns.has(sub.key)) {                       // second click on a running eye = cancel
        var ctrl = stVizRuns.get(sub.key);
        if (ctrl && typeof ctrl.abort === "function") ctrl.abort();
        return;
    }
    if (stVizCache.has(sub.key)) { stVizOpenBox(sub.key); return; }
    stVizRun(sub);
}

// --- Markup ---
function stVizEyeHTML(kind, idx) {
    if (!stVizEnabled()) return "";
    var sub = stVizSubject(kind, idx);
    if (!sub) return "";
    var running = stVizRuns.has(sub.key);
    var done = stVizCache.has(sub.key);
    var icon = running ? "fa-solid fa-spinner fa-spin" : "fa-regular fa-eye";
    var title = running ? "Cancel" : (done ? "Show picture" : "Visualize");
    return '<i class="st-viz-eye ' + icon + (done ? " st-viz-done" : "") + '"'
        + ' data-viz-kind="' + esc(kind) + '" data-viz-idx="' + idx + '"'
        + ' title="' + esc(title) + '"></i>';
}
/* `folded` (v1.13.0): the HUD passes true when the player folded the pictures
   away. Only the PICTURE goes: a run in flight keeps its status line, because
   that line is the only sign that the click did anything — and it is one line
   tall, which is not what the fold is there to save. The picture itself is not
   lost: its eye stays lit and opens the viewer. The dialog never folds. */
function stVizBlockHTML(kind, idx, folded) {
    if (!stVizEnabled()) return "";
    var sub = stVizSubject(kind, idx);
    if (!sub) return "";
    if (stVizRuns.has(sub.key)) {
        return '<div class="st-viz-status">' + esc(stVizStatusText.get(sub.key) || "Working…") + '</div>';
    }
    var rec = stVizCache.get(sub.key);
    if (!rec || folded) return "";
    return '<div class="st-viz-thumb" data-viz-key="' + esc(sub.key) + '" title="' + esc(rec.label) + '">'
        + '<img src="' + rec.image + '" alt=""></div>';
}

/* The fold button in the HUD head. Shown only while Visualize can work at all,
   and it says what a click WILL do, with the count of pictures it concerns —
   a folded panel otherwise gives no hint that there is anything to unfold. */
function stVizFoldSync() {
    if (typeof document === "undefined") return;
    /* The details button: says what a click WILL do, and how many characters
       a folded panel is keeping out of sight. */
    var det = document.getElementById("st-hud-details");
    var detailsShown = settings.hudDetails !== false;
    if (det) {
        var nc = (storyData && storyData.characters) ? storyData.characters.length : 0;
        det.classList.toggle("st-viz-fold-off", !detailsShown);
        det.title = detailsShown
            ? "Hide character details"
            : "Show character details" + (nc ? " (" + nc + " hidden)" : "");
    }
    var el = document.getElementById("st-viz-fold");
    if (!el) return;
    /* Pictures live inside the character details — with those folded the
       picture switch has nothing to act on. */
    var on = stVizEnabled() && detailsShown;
    el.style.display = on ? "" : "none";
    if (!on) return;
    var shown = settings.vizThumbs !== false;
    var n = stVizCache.size;
    el.classList.toggle("st-viz-fold-off", !shown);
    el.title = shown
        ? "Hide pictures in the panel" + (n ? " (" + n + ")" : "")
        : "Show pictures in the panel" + (n ? " (" + n + " hidden — the eye opens each)" : "");
}

/* ONE owner of the eye's wiring. The eye is drawn by two different panels
   (HUD and modal) and neither of them owns it, so the handlers do not belong
   to either builder.
   stopPropagation is not politeness here: the HUD body and the character
   cards both open the tracker dialog on click, so an eye that let the click
   through would start a generation AND throw a dialog over its own spinner. */
function stVizBindEvents() {
    $(document).on("click", ".st-viz-eye", function (e) {
        e.preventDefault(); e.stopPropagation();
        stVizClick(String($(this).attr("data-viz-kind") || ""), $(this).attr("data-viz-idx"));
    });
    $(document).on("click", ".st-viz-thumb", function (e) {
        e.preventDefault(); e.stopPropagation();
        stVizOpenBox(String($(this).attr("data-viz-key") || ""));
    });
    $(document).on("click", ".st-viz-status", function (e) { e.stopPropagation(); });
}

// --- Lightbox ---
/* ZOOM AND PAN (v1.13.0).
   The picture used to be shown fitted and nothing else: a 1086×1448 portrait
   in a 70vh box is seen at about half its pixels, and there was no way to get
   at the other half. Now the box is a STAGE the picture moves inside:

     wheel            zoom towards the cursor
     drag             pan (when the picture is larger than the stage)
     click            fitted ↔ actual pixels (1:1), at the point clicked
     − / + / 1:1      the same from the header, for a touchpad
     ↗                the picture alone in a new browser tab, full size

   The view is three numbers — scale (screen px per image px) and the offset
   of the picture's top-left corner inside the stage — and the three functions
   below are all the arithmetic there is. They take sizes as arguments and
   touch no DOM, so they can be checked without a browser. */
var ST_VIZ_ZOOM_MAX = 6;              // × actual pixels
var ST_VIZ_ZOOM_STEP = 1.25;          // one wheel notch / one button press
var ST_VIZ_CLICK_SLOP = 4;            // px a press may travel and still be a click
var stVizView = { s: 1, x: 0, y: 0 };

/* Fitted scale: the whole picture visible. Never above 1 — a small picture is
   shown at its own size, not blown up to fill the stage (same as before). */
function stVizFitScale(nw, nh, sw, sh) {
    if (!(nw > 0 && nh > 0 && sw > 0 && sh > 0)) return 1;
    return Math.min(sw / nw, sh / nh, 1);
}
/* A legal view: scale within [fit, max]; on an axis where the picture is
   smaller than the stage it is centred, otherwise it may not leave a gap. */
function stVizClampView(v, nw, nh, sw, sh) {
    var fit = stVizFitScale(nw, nh, sw, sh);
    var s = Math.min(Math.max(Number(v.s) || fit, fit), Math.max(ST_VIZ_ZOOM_MAX, fit));
    var w = nw * s, h = nh * s;
    var x = w <= sw ? (sw - w) / 2 : Math.min(0, Math.max(sw - w, Number(v.x) || 0));
    var y = h <= sh ? (sh - h) / 2 : Math.min(0, Math.max(sh - h, Number(v.y) || 0));
    return { s: s, x: x, y: y };
}
/* Zoom to scale s2 keeping the image point under stage point (px,py) where it
   is — that is what makes the wheel feel like it zooms "into the cursor". The
   scale is clamped FIRST: computing the offset for a scale that then gets cut
   would slide the picture sideways at either end of the range. */
function stVizZoomTo(v, s2, px, py, nw, nh, sw, sh) {
    var fit = stVizFitScale(nw, nh, sw, sh);
    var s = Math.min(Math.max(s2, fit), Math.max(ST_VIZ_ZOOM_MAX, fit));
    var ix = (px - v.x) / v.s, iy = (py - v.y) / v.s;
    return stVizClampView({ s: s, x: px - ix * s, y: py - iy * s }, nw, nh, sw, sh);
}

/* THE STAGE HUGS THE FITTED PICTURE (v1.13.1). In 1.13.0 the stage had a fixed
   size of its own — 88vw × 70vh — so that a zoomed picture had room; but that
   made every picture open in a landscape window, a portrait sitting in a wide
   dark box, and the one-line prompt under it stretched the window wider still.
   The window is the picture's own shape again: the stage is exactly the fitted
   picture, inside the same share of the viewport the old viewer used, and
   zooming pans within that frame ("open full size" is the way out of it).
   Floored, never rounded: a stage a fraction of a pixel LARGER than the fitted
   picture would show a hairline of background along one edge. */
var ST_VIZ_AREA = { w: 0.88, h: 0.70, maxW: 1600 };   // share of the viewport a picture may take
function stVizStageSize(nw, nh, aw, ah) {
    if (!(nw > 0 && nh > 0 && aw > 0 && ah > 0)) return null;
    var fit = stVizFitScale(nw, nh, aw, ah);
    return { w: Math.max(1, Math.floor(nw * fit)), h: Math.max(1, Math.floor(nh * fit)) };
}
function stVizLayout() {
    var img = document.getElementById("st-viz-img"), st = document.getElementById("st-viz-stage");
    if (!img || !st) return;
    var size = stVizStageSize(img.naturalWidth, img.naturalHeight,
        Math.min(window.innerWidth * ST_VIZ_AREA.w, ST_VIZ_AREA.maxW), window.innerHeight * ST_VIZ_AREA.h);
    if (!size) return;                    // not decoded yet — the load event comes back here
    st.style.width = size.w + "px";
    st.style.height = size.h + "px";
}

function stVizDims() {
    var img = document.getElementById("st-viz-img"), st = document.getElementById("st-viz-stage");
    if (!img || !st) return null;
    return { img: img, st: st, nw: img.naturalWidth, nh: img.naturalHeight, sw: st.clientWidth, sh: st.clientHeight };
}
function stVizApplyView() {
    var d = stVizDims();
    if (!d || !d.nw || !d.sw) return;
    stVizView = stVizClampView(stVizView, d.nw, d.nh, d.sw, d.sh);
    d.img.style.transform = "translate(" + stVizView.x + "px," + stVizView.y + "px) scale(" + stVizView.s + ")";
    var fit = stVizFitScale(d.nw, d.nh, d.sw, d.sh);
    var fitted = Math.abs(stVizView.s - fit) < 1e-4;
    d.st.classList.toggle("st-viz-zoomed", !fitted);
    $("#st-viz-zoom").text(Math.round(stVizView.s * 100) + "%" + (fitted ? " · fit" : ""));
    /* The button names where a click on it leads, not where the view is. */
    $("#st-viz-11").text(fitted ? "1:1" : "Fit").attr("title", fitted ? "Actual pixels" : "Fit to window");
    $("#st-viz-size").text(d.nw + "×" + d.nh);
}
function stVizResetView() {
    stVizLayout();                        // the frame first: the fitted scale is measured against it
    var d = stVizDims();
    if (!d || !d.nw || !d.sw) return;
    stVizView = { s: stVizFitScale(d.nw, d.nh, d.sw, d.sh), x: 0, y: 0 };
    stVizApplyView();
}
function stVizZoomBy(factor, px, py) {
    var d = stVizDims();
    if (!d || !d.nw || !d.sw) return;
    if (px == null) { px = d.sw / 2; py = d.sh / 2; }
    stVizView = stVizZoomTo(stVizView, stVizView.s * factor, px, py, d.nw, d.nh, d.sw, d.sh);
    stVizApplyView();
}
/* Fitted → actual pixels at (px,py); anything else → back to fitted. A picture
   that already fits at 1:1 has nothing to show at "actual pixels", so there
   the toggle goes to 2× instead of doing nothing. */
function stVizToggle11(px, py) {
    var d = stVizDims();
    if (!d || !d.nw || !d.sw) return;
    var fit = stVizFitScale(d.nw, d.nh, d.sw, d.sh);
    if (Math.abs(stVizView.s - fit) >= 1e-4) { stVizResetView(); return; }
    if (px == null) { px = d.sw / 2; py = d.sh / 2; }
    stVizView = stVizZoomTo(stVizView, fit >= 1 ? 2 : 1, px, py, d.nw, d.nh, d.sw, d.sh);
    stVizApplyView();
}
/* The picture by itself in a new tab. A data: URI cannot be opened as a page
   (browsers block top-level navigation to it), so it goes through a Blob. */
function stVizOpenFull() {
    var rec = stVizCache.get(stVizBoxKey);
    if (!rec || !rec.image) return;
    try {
        var m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(rec.image);
        var url = rec.image;
        if (m) {
            var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            url = URL.createObjectURL(new Blob([bytes], { type: m[1] || "image/png" }));
            setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { } }, 120000);
        }
        var a = document.createElement("a");
        a.href = url; a.target = "_blank"; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
    } catch (e) {
        console.error("[Story Tracker] open full size:", e);
        if (typeof toastr !== "undefined") toastr.error("Could not open the picture in a new tab.");
    }
}

var stVizBoxKey = "";
function stVizCloseBox() { $("#st-viz-box").fadeOut(120); stVizBoxKey = ""; }
function stVizBuildBox() {
    if (document.getElementById("st-viz-box")) return;
    var h = '<div id="st-viz-box" style="display:none"><div class="st-viz-ovl"></div><div class="st-viz-inner">'
        + '<div class="st-viz-head"><span id="st-viz-title"></span>'
        + '<span class="st-viz-size" id="st-viz-size"></span>'
        + '<button class="menu_button st-viz-hbtn" id="st-viz-zout" title="Zoom out"><i class="fa-solid fa-magnifying-glass-minus"></i></button>'
        + '<span class="st-viz-zoom" id="st-viz-zoom"></span>'
        + '<button class="menu_button st-viz-hbtn" id="st-viz-zin" title="Zoom in"><i class="fa-solid fa-magnifying-glass-plus"></i></button>'
        + '<button class="menu_button st-viz-hbtn st-viz-11" id="st-viz-11" title="Actual pixels">1:1</button>'
        + '<button class="menu_button st-viz-hbtn" id="st-viz-full" title="Open full size in a new tab"><i class="fa-solid fa-up-right-from-square"></i></button>'
        + '<button class="menu_button st-viz-hbtn" id="st-viz-redraw" title="Redraw"><i class="fa-solid fa-rotate"></i></button>'
        + '<button class="menu_button st-viz-hbtn" id="st-viz-close" title="Close"><i class="fa-solid fa-xmark"></i></button>'
        + '</div><div class="st-viz-stage" id="st-viz-stage" title="Wheel: zoom · drag: pan · click: 1:1 / fit">'
        + '<img id="st-viz-img" src="" alt="" draggable="false"></div>'
        + '<div class="st-viz-prompt" id="st-viz-prompt"></div>'
        + '</div></div>';
    document.body.insertAdjacentHTML("beforeend", h);
    $(document).on("click", ".st-viz-ovl, #st-viz-close", stVizCloseBox);
    $(document).on("click", "#st-viz-redraw", function () {
        var rec = stVizCache.get(stVizBoxKey);
        if (!rec) return;
        stVizCache.delete(stVizBoxKey);                 // the old picture is gone: a redraw replaces it
        stVizCloseBox();
        var sub = stVizSubject(rec.kind, rec.idx);
        if (sub) stVizRun(sub); else stVizRefresh();
    });
    $(document).on("click", "#st-viz-zin", function () { stVizZoomBy(ST_VIZ_ZOOM_STEP); });
    $(document).on("click", "#st-viz-zout", function () { stVizZoomBy(1 / ST_VIZ_ZOOM_STEP); });
    $(document).on("click", "#st-viz-11", function () { stVizToggle11(); });
    $(document).on("click", "#st-viz-full", stVizOpenFull);

    var stage = document.getElementById("st-viz-stage"), img = document.getElementById("st-viz-img");
    /* A data: URI still decodes asynchronously — the natural size is not known
       until load, and without it there is no fitted scale to start from. */
    img.addEventListener("load", stVizResetView);
    /* Bound on the element, not delegated: the page behind must not scroll
       while the wheel zooms, and that needs a non-passive listener. */
    stage.addEventListener("wheel", function (e) {
        e.preventDefault();
        var r = stage.getBoundingClientRect();
        stVizZoomBy(e.deltaY < 0 ? ST_VIZ_ZOOM_STEP : 1 / ST_VIZ_ZOOM_STEP, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    /* One gesture, two meanings: a press that travels is a pan, a press that
       stays put is a click (fit ↔ 1:1). Decided on release by distance. */
    var drag = null;
    stage.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        drag = { x0: e.clientX, y0: e.clientY, vx: stVizView.x, vy: stVizView.y, moved: 0 };
        try { stage.setPointerCapture(e.pointerId); } catch (x) { }
        e.preventDefault();
    });
    stage.addEventListener("pointermove", function (e) {
        if (!drag) return;
        var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
        drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
        if (drag.moved <= ST_VIZ_CLICK_SLOP) return;
        stage.classList.add("st-viz-dragging");
        stVizView = { s: stVizView.s, x: drag.vx + dx, y: drag.vy + dy };
        stVizApplyView();
    });
    function endDrag(e) {
        if (!drag) return;
        var wasClick = drag.moved <= ST_VIZ_CLICK_SLOP;
        drag = null;
        stage.classList.remove("st-viz-dragging");
        try { stage.releasePointerCapture(e.pointerId); } catch (x) { }
        if (wasClick && e.type === "pointerup") {
            var r = stage.getBoundingClientRect();
            stVizToggle11(e.clientX - r.left, e.clientY - r.top);
        }
    }
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", function () { if (stVizBoxKey) stVizResetView(); });
    document.addEventListener("keydown", function (e) {
        if (!stVizBoxKey) return;
        if (e.key === "Escape") { e.stopPropagation(); stVizCloseBox(); }
        else if (e.key === "+" || e.key === "=") stVizZoomBy(ST_VIZ_ZOOM_STEP);
        else if (e.key === "-") stVizZoomBy(1 / ST_VIZ_ZOOM_STEP);
        else if (e.key === "0") stVizResetView();
    }, true);
}
function stVizOpenBox(key) {
    var rec = stVizCache.get(key);
    if (!rec) return;
    stVizBuildBox();
    stVizBoxKey = key;
    $("#st-viz-title").text(rec.label || "Visualization");
    $("#st-viz-img").attr("src", rec.image);
    $("#st-viz-prompt").text(rec.prompt || "");
    $("#st-viz-box").fadeIn(120);
    /* The same picture reopened fires no load event, and the stage has no size
       until the box is displayed — so fit once more now that both are true. */
    stVizResetView();
}

/* ═══════════════════════════════════════════════════════════════
   PUBLIC API — window.StoryTrackerAPI (GM Turn §9.1, layer GM-C)

   The Game Shell can now get the scene out of the MAIN generation (one
   <gm> block appended to the reply) instead of paying for this extension's
   own quiet analysis every few messages. That data has to land here, and the
   only safe way in is a narrow API: every helper below is module-private.

   Why this is NOT "call doLLMUpdate's apply block with a different source":
   that block ASSIGNS unconditionally — `storyData.custom = (data.custom && …)
   ? data.custom : {}` and `storyData.characters = Array.isArray(...) ? ... : []`.
   Fed a partial GM payload it would erase the user's custom fields and empty
   the presence roster on the first turn. applyScene therefore merges: a field
   the block did not mention keeps its old value, and `custom` is never touched
   from outside at all.

   The history entry lives in applyHistory, not here: the Shell applies the
   scene on every swipe (display tier) but commits history exactly once per
   turn (commit tier) — history.unshift on each swipe would pile up alternate
   timelines that later get injected into the prompt as fact.
   ═══════════════════════════════════════════════════════════════ */

var ST_API_VERSION = "1.5.0";   /* 2026-10-25: getAppearance(name) — the current look of one character (Scene Director draws it). 1.4.0: day_of_week through getScene/applyScene */

function stApiBlank(v) { return !v || String(v).trim() === "" || String(v).trim().toLowerCase() === "unknown"; }

function stApiEnsureData() {
    if (!storyData) { try { loadStoryData(); } catch (e) { } }
    return storyData;
}

/* Values arriving through the API are already in the player's language — no
   translation happened. When the panel is currently showing a translation, the
   matching _orig* snapshot must move with the value, or "Show Original" would
   restore pre-GM text and injectContextToChat (which prefers _orig*) would
   feed the model a location the story left three scenes ago. */
function stApiSet(field, origField, value) {
    storyData[field] = value;
    if (storyData._translated && origField) storyData[origField] = value;
}

function installStoryTrackerApi() {
    var api = {
        version: ST_API_VERSION,
        isAvailable: function () { return !!(scriptModule && settings && settings.enabled); },

        /* Deep copy: callers snapshot this before applying a payload so a swipe
           can put the scene back exactly as it was. */
        getScene: function () {
            var sd = stApiEnsureData();
            if (!sd) return null;
            try {
                return JSON.parse(JSON.stringify({
                    time: sd.time, date: sd.date, day_of_week: sd.day_of_week, location: sd.location,
                    city: sd.city, country: sd.country,
                    temperature: sd.temperature, weather: sd.weather,
                    characters: sd.characters || [], recent_events: sd.recent_events || "",
                    _initialized: !!sd._initialized
                }));
            } catch (e) { return null; }
        },

        /* Merge-only scene update. Returns the list of fields that changed.
           opts.replace — restore mode (GM Turn swipe rollback): every key the
           caller passes wins, even an empty one. A merge cannot undo a payload,
           because the fields it introduced are exactly the ones the snapshot
           has empty.
           opts.silent (v1.1) — do not broadcast ST_SCENE_EVENT. For a caller
           that is not REPORTING a scene change but RECORDING one it already
           announced itself: Lore World writes the place it just travelled to,
           and re-broadcasting it would hand its own move back to every listener
           as fresh news — including the listeners that answer news with an LLM
           call. Silence here is not a lost signal; it is the absence of an
           echo. */
        applyScene: function (d, opts) {
            var out = { applied: [], ok: false };
            var sd = stApiEnsureData();
            if (!sd || !d || typeof d !== "object") return out;
            var replace = !!(opts && opts.replace);
            var has = function (k) { return replace && Object.prototype.hasOwnProperty.call(d, k); };
            try {
                /* snapshot BEFORE the write — the broadcast compares old vs new */
                var prevScene = { initialized: !!sd._initialized, location: sd.location, date: sd.date };

                if (d.time || has("time")) { stApiSet("time", null, String(d.time || "")); out.applied.push("time"); }
                if (d.date || has("date")) { stApiSet("date", null, String(d.date || "")); out.applied.push("date"); }
                /* v1.4: the weekday is a field of its own here (the model is
                   asked for it separately), so an owner of the calendar has to
                   be able to write it — a date alone would leave yesterday's
                   weekday standing next to today's date. */
                if (d.day_of_week || has("day_of_week")) { stApiSet("day_of_week", "_origDayOfWeek", String(d.day_of_week || "")); out.applied.push("day_of_week"); }
                if (d.location || has("location")) { stApiSet("location", "_origLocation", String(d.location || "")); out.applied.push("location"); }
                if (!stApiBlank(d.city) || has("city")) { stApiSet("city", "_origCity", String(d.city || "")); out.applied.push("city"); }
                if (!stApiBlank(d.country) || has("country")) { stApiSet("country", "_origCountry", String(d.country || "")); out.applied.push("country"); }
                if (d.temperature || has("temperature")) { stApiSet("temperature", "_origTemperature", String(d.temperature || "")); out.applied.push("temperature"); }
                if (d.weather || has("weather")) { stApiSet("weather", "_origWeather", String(d.weather || "")); out.applied.push("weather"); }
                if (replace && Array.isArray(d.characters)) {
                    storyData.characters = JSON.parse(JSON.stringify(d.characters));
                    if (storyData._translated) storyData._origCharacters = JSON.parse(JSON.stringify(d.characters));
                    out.applied.push("characters");
                } else if (Array.isArray(d.characters) && d.characters.length) {
                    var list = d.characters.map(function (c) {
                        if (typeof c === "string") return { name: c, state: "" };
                        return { name: String((c && c.name) || ""), state: String((c && c.state) || "") };
                    }).filter(function (c) { return c.name; });
                    if (list.length) {
                        storyData.characters = list;
                        if (storyData._translated) storyData._origCharacters = JSON.parse(JSON.stringify(list));
                        out.applied.push("characters");
                    }
                }
                if (d.recent_events || has("recent_events")) { stApiSet("recent_events", "_origEvents", String(d.recent_events || "")); out.applied.push("recent_events"); }
                /* storyData.custom belongs to the user's custom fields — the GM
                   block has no such key and must never be able to clear it. */

                if (stApiBlank(storyData.city)) storyData.city = "Unknown";
                if (stApiBlank(storyData.country)) storyData.country = "Unknown";
                storyData._initialized = true;

                if (!out.applied.length) return out;
                saveStoryData();
                syncToCharTracker();
                if (!(opts && opts.silent)) maybeEmitSceneChange(prevScene);
                try { renderModal(); renderHUD(); } catch (e) { }
                if (settings.enabled && settings.injectToContext) { try { injectContextToChat(); } catch (e) { } }
                out.ok = true;
            } catch (e) { console.warn("[Story Tracker] applyScene:", e); }
            return out;
        },

        /* v1.14.0. How ONE character looks right now, for whoever draws them:
           the record in the language the model wrote it (a prompt is not the
           translated HUD), the custom fields under their LABELS ("Clothes"),
           and what the Inventory says they wear or hold. null when the tracker
           has nobody by that name. */
        getAppearance: function (name) {
            var sd = stApiEnsureData();
            if (!sd || !name) return null;
            try {
                var orig = sd._origCharacters || sd.characters || [];
                var shown = sd.characters || [];
                var idx = stFindCharIndex([orig, shown], name);
                if (idx < 0) return null;
                var o = orig[idx] || shown[idx] || {}, d = shown[idx] || o;
                var all = sd._origCustom || sd.custom || {};
                var vals = all[o.name] || all[d.name] || (sd.custom || {})[d.name] || {};
                var labels = {};
                (settings.customFields || []).forEach(function (f) { if (f && f.id) labels[f.id] = f.label || f.id; });
                var fields = {};
                Object.keys(vals).forEach(function (k) {
                    var v = String(vals[k] == null ? "" : vals[k]).trim();
                    if (v) fields[labels[k] || k] = v;
                });
                return {
                    name: String(o.name || d.name || ""),
                    state: String(o.state || d.state || ""),
                    fields: fields,
                    outfit: stOutfitTail(o.name || d.name).replace(/^,\s*/, "")
                };
            } catch (e) { return null; }
        },

        /* Commit tier: one history entry per turn, same shape doLLMUpdate writes. */
        applyHistory: function (d) {
            var sd = stApiEnsureData();
            if (!sd) return false;
            try {
                if (!Array.isArray(sd.history)) sd.history = [];
                sd.history.unshift({
                    msg: msgCounter,
                    time: sd.time, loc: sd.location,
                    temperature: sd.temperature, weather: sd.weather,
                    events: (d && d.recent_events) || sd.recent_events || "",
                    chars: JSON.parse(JSON.stringify(sd.characters || [])),
                    custom: JSON.parse(JSON.stringify(sd.custom || {}))
                });
                if (sd.history.length > 20) sd.history.pop();
                saveStoryData();
                try { renderModal(); } catch (e) { }
                return true;
            } catch (e) { console.warn("[Story Tracker] applyHistory:", e); return false; }
        }
    };
    try { if (typeof window !== "undefined") window.StoryTrackerAPI = api; } catch (e) { }
    try { if (typeof globalThis !== "undefined") globalThis.StoryTrackerAPI = api; } catch (e) { }
}

function syncTranslateBtn() {
    let $b = $("#st-h-translate");
    if (storyData && storyData._translated) $b.addClass("st-btn-tr-active").attr("title", "Show Original").html('<i class="fa-solid fa-rotate-left"></i>');
    else $b.removeClass("st-btn-tr-active").attr("title", "Translate").html('<i class="fa-solid fa-language"></i>');
}