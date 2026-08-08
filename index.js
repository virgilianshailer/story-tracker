/*
 * Story Tracker — SillyTavern Extension
 * Keeps track of Time, Date, Location, Character Positions, and Recent Events.
 * Reduces amnesia by injecting scene context into LLM prompts.
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
        installStoryTrackerApi();
        stBindLangSwitch();          // §9.2

        // Safety net: restore the main profile if a previous analysis was interrupted
        // by a page reload. Runs after a short delay so Connection Manager finishes loading.
        setTimeout(function () { recoverProfileIfNeeded(); }, 1500);

        console.log("[Story Tracker] Loaded!");
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

async function doLLMUpdate() {
    if (!genQuiet) throw new Error("LLM generation not available.");

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
    var raw = await withConnectionProfile(function () { return genQuiet({ quietPrompt: prompt }); });

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
    if (!stHostDrivesTime()) storyData.time = data.time || storyData.time;
    storyData.date = data.date || storyData.date;
    storyData.location = data.location || storyData.location;

    // City / country: treat "Unknown" (case-insensitive) as missing — will trigger fallback below
    let isBlank = v => !v || v.trim().toLowerCase() === "unknown" || v.trim() === "";
    storyData.city    = !isBlank(data.city)    ? data.city    : (isBlank(storyData.city)    ? null : storyData.city);
    storyData.country = !isBlank(data.country) ? data.country : (isBlank(storyData.country) ? null : storyData.country);

    // Day of week is now mandatory from the model (same "never Unknown" contract as
    // city/country). No second fallback call, though: unlike an invented place name,
    // a missing weekday can be recovered for free from the date client-side below.
    storyData.day_of_week = !isBlank(data.day_of_week) ? data.day_of_week : (isBlank(storyData.day_of_week) ? null : storyData.day_of_week);

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
        msgCounter++;
        saveStoryData();
        
        // Initial setup on 1st message, or auto-update
        let isFirstMsg = scriptModule.chat.length <= 2 && !storyData._initialized;
        
        if (isFirstMsg || (settings.autoUpdate && msgCounter % settings.autoUpdateInterval === 0)) {
            busy = true;
            try {
                await doLLMUpdate();
                renderModal(); renderHUD();
            } catch(e) { console.error(e); }
            busy = false;
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
    h += '<div class="st-section"><div class="st-sec-title"><i class="fa-solid fa-scroll"></i> Recent Events (Summary)</div><div class="st-summary-box" id="st-val-events"></div></div>';
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
        
        var outfit = getInventoryOutfit();
        var userName = (scriptModule && scriptModule.name1) ? scriptModule.name1 : null;

        let cHtml = "";
        if (storyData.characters) {
            storyData.characters.forEach(c => {
                var stateText = c.state;

                // Append user outfit as plain text
                if (outfit && outfit.userEquipped.length > 0) {
                    var isUser = (userName && c.name.toLowerCase() === userName.toLowerCase()) ||
                                 c.name.toLowerCase() === "user" ||
                                 c.name.toLowerCase() === "вы" ||
                                 c.name === "{{user}}";
                    if (isUser) {
                        var wearNames = outfit.userEquipped.map(function(it) { return it.name; }).join(", ");
                        stateText += ", wearing " + wearNames;
                    }
                }

                // Append held items for AI characters as plain text
                if (outfit && outfit.charItems.length > 0) {
                    var held = outfit.charItems.filter(ci => ci.heldBy && ci.heldBy.toLowerCase() === c.name.toLowerCase());
                    if (held.length > 0) {
                        var heldNames = held.map(function(ci) { return ci.name; }).join(", ");
                        stateText += ", holding " + heldNames;
                    }
                }

                cHtml += '<div class="st-char-card"><div class="st-char-name">' + esc(c.name) + '</div><div class="st-char-state">' + esc(stateText) + '</div></div>';
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
                if (rows) custHtml += '<div class="st-char-card"><div class="st-char-name">' + esc(charName) + '</div><div class="st-char-state">' + rows + '</div></div>';
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
    let h = `<div id="st-hud" class="st-hud st-hud-pos-${settings.hudPosition}"><div class="st-hud-head"><i class="fa-solid fa-book"></i> Tracker <i style="margin-left:auto" class="fa-solid fa-chevron-up"></i></div><div class="st-hud-body" id="st-hud-body"></div></div>`;
    document.body.insertAdjacentHTML("beforeend", h);
    $(document).on("click", ".st-hud-head", function() { $("#st-hud").toggleClass("st-hud-collapsed"); });
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

    if (!storyData || !storyData._initialized) {
        $("#st-hud-body").html("<div style='text-align:center;opacity:.5;font-size:10px;'>Waiting...</div>"); return;
    }
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
    h += `<hr style="border-color:rgba(255,255,255,0.05);margin:5px 0;">`;
    
    var hudOutfit = getInventoryOutfit();
    var hudUserName = (scriptModule && scriptModule.name1) ? scriptModule.name1 : null;

    if (storyData.characters) {
        storyData.characters.forEach(c => {
            var hudStateText = c.state;

            // Append user outfit as plain text
            if (hudOutfit && hudOutfit.userEquipped.length > 0) {
                var isUser = (hudUserName && c.name.toLowerCase() === hudUserName.toLowerCase()) ||
                             c.name.toLowerCase() === "user" ||
                             c.name.toLowerCase() === "вы" ||
                             c.name === "{{user}}";
                if (isUser) {
                    var wearNames = hudOutfit.userEquipped.map(function(it) { return it.name; }).join(", ");
                    hudStateText += ", wearing " + wearNames;
                }
            }

            // Append held items for AI characters as plain text
            if (hudOutfit && hudOutfit.charItems.length > 0) {
                var hudHeld = hudOutfit.charItems.filter(ci => ci.heldBy && ci.heldBy.toLowerCase() === c.name.toLowerCase());
                if (hudHeld.length > 0) {
                    var heldNames = hudHeld.map(function(ci) { return ci.name; }).join(", ");
                    hudStateText += ", holding " + heldNames;
                }
            }

            h += '<div class="st-hud-char"><span class="st-hud-char-name">' + esc(c.name) + ':</span> ' + esc(hudStateText) + '</div>';

            // Custom tracked fields for this character
            if (settings.customFields && settings.customFields.length > 0 && storyData.custom && storyData.custom[c.name]) {
                var fieldLabelsHud = {};
                settings.customFields.forEach(function (f) { fieldLabelsHud[f.id] = f.label; });
                var custVals = storyData.custom[c.name];
                var custParts = Object.keys(custVals).map(function (k) { return (fieldLabelsHud[k] || k) + ": " + custVals[k]; });
                if (custParts.length > 0) h += '<div class="st-hud-outfit">' + esc(custParts.join(" · ")) + '</div>';
            }
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

    if (storyData.custom) {
        for (let charName in storyData.custom) {
            let vals = storyData.custom[charName];
            if (!vals || typeof vals !== "object") continue;
            for (let key in vals) {
                if (vals[key] && typeof vals[key] === "string") vals[key] = await tr(vals[key]);
            }
        }
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

var ST_API_VERSION = "1.3.0";   /* 2026-08-02: stands down when the host owns the scene; the city/country fallback asks once per place */

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
                    time: sd.time, date: sd.date, location: sd.location,
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