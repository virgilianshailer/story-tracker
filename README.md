# 📖 Story Tracker — SillyTavern Extension

A SillyTavern extension that automatically tracks **time, date, location, weather, character positions, outfits, and recent events** in your roleplay. It uses the LLM to analyze the chat and maintain narrative consistency, reducing character amnesia between messages.

📺 [Video demo](https://youtu.be/Lx2nBumpsd0)

---

## ✨ Features

- **Scene Context Tracking** — Automatically extracts current time, date, and specific location from the narrative.
- **Day of Week** — Calculated automatically from the in-story date.
- **Temperature & Weather** — Tracks the current temperature (°C / °F) and weather conditions (clear, rainy, cloudy, snowing, stormy, foggy, etc.), with matching weather icons in the HUD.
- **City & Country / Realm (optional)** — When enabled, the LLM determines or invents a fitting city and country/realm based on the setting. For fantasy or sci-fi worlds it creates original names that match the story; for real-world settings it uses actual place names; for known fictional universes (Westeros, Middle-earth, etc.) it uses canonical names. A dedicated fallback prompt is fired if the main scene analysis leaves these fields empty.
- **Character Position Log** — Keeps track of every character present in the scene and their current action or posture.
- **Outfit & Held Items Integration** — When the Inventory extension is installed, the user's currently equipped clothing and any items held by the AI character are appended to the character lines (e.g. "*sitting on the bed, wearing leather jacket, jeans, boots*") and injected into the LLM prompt so outfits are never forgotten.
- **Custom Tracking Fields** — Define your own narrative parameters (e.g. "Emotional State", "Growth Level") for the LLM to track alongside the built-in scene data, with reusable presets you can save and swap between chats.
- **Recent Events Summary** — A concise LLM-generated summary of what just happened in the last few messages.
- **Context Injection** — Injects the current scene state (time, date, location, city/country, weather, character positions, outfit, held items, custom fields) into the Author's Note before each generation, reducing AI amnesia.
- **HUD Widget** — A compact floating overlay that shows the current scene at a glance: time, date, day of week, location, optional city/country, weather with icon, and up to 3 character positions with their outfits.
- **Adjustable HUD** — Resize the HUD widget from 50% to 200% and place it in any of the four screen corners.
- **History Log** — Stores past scene snapshots so you can review how the story evolved.
- **Translation Support** — Integrates with the SillyTavern Translate extension to display data in your target language while keeping original text intact for LLM prompts.
- **Character Tracker Sync** — Pushes time, date, and location data into the Character Tracker extension if it is active.
- **Lore Atlas Bridge** — Broadcasts scene changes so Lore Atlas can react, and lets you jump straight from the modal to the current location's entry.
- **Shell / Game Mode Aware** — When running under shell-engines, defers ownership of time (or the whole scene) to the active game mode's clock instead of overwriting it.
- **Auto-Update** — Triggers an LLM scene analysis automatically every N messages (configurable).
- **Separate Connection Profile for Analysis** — Optionally route scene analysis through a different (e.g. cheaper / faster) Connection Profile, then automatically switch back to your main profile when done.

---

## 📦 Installation

1. In SillyTavern, open **Extensions → Install Extension**.
2. Paste the URL of this repository and click **Install**.

Or install manually:

```
SillyTavern/
└── public/
    └── extensions/
        └── story-tracker/
            ├── index.js
            ├── style.css
            └── manifest.json
```

Clone or copy the files into a folder named `story-tracker` inside `public/extensions/`, then reload SillyTavern.

---

## ⚙️ Settings

Open **Extensions → Story Tracker** in the SillyTavern sidebar to access settings.

| Setting | Description |
|---|---|
| **Enable Extension** | Master toggle for the entire extension. |
| **Show HUD Widget** | Show/hide the floating scene overlay. |
| **HUD Position** | Corner where the HUD appears (Bottom Right / Left, Top Right / Left). |
| **HUD Scale** | Resize the HUD widget (50–200%). |
| **Show Icon in Chat Panel** | Show/hide the 📖 button in the message input bar. |
| **Auto-update LLM Scene** | Automatically re-analyze the scene every N messages. |
| **Update Every N Messages** | How often the auto-update fires (1–20 messages). |
| **Inject Context into Prompt** | Inserts current scene info into the Author's Note before generation. |
| **Show History** | Keep the History / Stats log of past scene updates. |
| **Show City / Country** | Show city and country/realm fields in the tracker (LLM infers or invents them based on the story setting). |
| **Custom Tracking Fields** | Add your own LLM-tracked narrative parameters, with reusable presets. |
| **Broadcast Scene Changes** | Emit scene-change events for other extensions (Lore Atlas bridge). |
| **Use a separate Connection Profile for analysis** | Run scene analysis on a different profile (e.g. a cheaper model), then automatically restore the main profile afterwards. Requires the built-in **Connection Profiles** extension. |
| **Analysis Profile** | The Connection Profile used for scene analysis when the toggle above is enabled. Leave on *"— Use current / main profile —"* to disable routing. |

---

## 🖥️ Interface

### Modal Window
Open by clicking the **📖 book icon** in the chat input bar or via the settings panel.

- **Current Scene tab** — Shows time, date, location, character positions, and a recent events summary.
- **History / Stats tab** — A log of all past scene updates with timestamps and summaries.
- **Update Now** button — Forces an immediate LLM scene analysis.
- **Translate** button — Toggles translation of displayed data (requires the Translate extension).

### HUD Widget
A small floating panel that shows time, date, location, and up to 3 character positions at a glance. Click the header to collapse/expand it. Click the body to open the full modal.

---

## 🔄 Using a Separate Connection Profile

Story Tracker can run its scene analysis on a different Connection Profile than the one you use for chat generation. This is useful if you want to:

- Use a **cheaper / faster model** for background analysis (e.g. a small local model or a low-cost API).
- Keep your **main profile reserved for chat** so creative writing quality is never affected.
- Avoid burning tokens on your premium model just to update the tracker.

**How it works:**
1. Install/enable the built-in **Connection Profiles** extension in SillyTavern.
2. Create at least one additional profile for analysis (any model/API).
3. In Story Tracker settings, enable **"Use a separate Connection Profile for analysis"** and pick your analysis profile.
4. When Story Tracker runs an update, it temporarily switches to the analysis profile, performs the LLM call, then switches back to your original profile automatically.

If a page reload interrupts the analysis mid-switch, Story Tracker detects this on the next load and quietly restores your main profile, so you'll never be stuck on the wrong model.

---

## 🔗 Compatibility

| Extension | Integration |
|---|---|
| **Character Tracker** | Time, date, and location data is pushed automatically on each update. |
| **Inventory** | Equipped outfits and held items are pulled into character lines and injected into the LLM prompt. |
| **Translate** | Location, events, and character states can be displayed in your target language. |
| **Connection Profiles** | Optional — required only if you want to route scene analysis through a separate profile. |
| **Lore Atlas** | Optional — receives scene-change broadcasts and lets you jump to the current location's entry from the modal. |
| **shell-engines** | Optional — when present, the active game mode's clock takes ownership of time (or the whole scene) instead of Story Tracker overwriting it. |

---

## 📋 Requirements

- SillyTavern (recent version with extension support)
- Any LLM backend connected to SillyTavern
- *(Optional)* The built-in **Connection Profiles** extension — only needed if you want to use a separate profile for analysis.

---

## 📜 Version History

### 1.9.1
- **NEW:** Custom Tracking Fields — define your own narrative parameters for the LLM to track each turn, with reusable presets across chats.
- **NEW:** Lore Atlas bridge — broadcasts scene changes and adds a jump-to-location-entry button in the modal.
- **NEW:** Shell / Game Mode awareness — hands off ownership of time (or the whole scene) to an active game mode's clock instead of overwriting it.
- **NEW:** Show History toggle to disable the History / Stats log independently of the rest of the UI.
- Various stability and integration fixes accumulated since 1.1.0.

### 1.1.0
- **NEW:** Added support for using a separate **Connection Profile** for scene analysis. Story Tracker can now switch to a configured profile (e.g. a cheaper model) before each analysis and automatically restore the main profile afterwards.
- **NEW:** Added an Analysis Profile dropdown in settings, with a refresh button to reload the list of available profiles.
- Added a safety net: if a page reload interrupts an analysis while a profile switch was active, the original profile is restored on the next load.

### 1.0.0
- Initial release.
- Scene context tracking (time, date, day of week, location).
- Temperature and weather tracking with HUD icons.
- Optional City & Country / Realm field (LLM infers or invents).
- Character position log.
- Outfit & held items integration via the Inventory extension.
- Recent events summary.
- HUD widget and modal interface (adjustable size and position).
- Author's Note context injection.
- History log (up to 20 snapshots).
- Translate extension support.
- Character Tracker extension sync.

---

## 📄 License

MIT — free to use, modify, and distribute.
