# Privacy

## What is read

Exactly these fields, and nothing else:

- A normalized **0..1 progress ratio** (`QueueReading.progress` / `ContentReading.progress`), or
  `null` when there is no trustworthy value.
- A **status**: `loading`, `waiting`, `ready`, `unknown`, `error`, or `closed`
  (`src/domain/types.ts`'s `TabStatus`).
- An **adapter id** (`ContentReading.adapter`): the identifier of whichever page-reading adapter
  matched the page (e.g. `"progress-element"`), or `null` if none matched. This tells you which
  parser produced a reading, not anything about the page's content.
- **Timestamps**: when a reading was taken (`readAt`), when the session was created/updated, and
  when the last polling round finished.
- **Numeric tab ids** (`chrome` tab IDs) — used to track which tab a reading belongs to and to
  preserve tracked-tab order.
- A monotonic **sequence number** (`seq`) per reading, used only to discard out-of-order
  responses.

That's the entire `ContentReading`/`QueueReading` contract (`src/domain/messages.ts`,
`src/domain/types.ts`). The content script (`src/content/reader.ts`) builds exactly these five
fields and nothing else, by design — adding anything else to that object would be a layering
violation of the contract it exists to enforce.

## What is not read

- Form inputs, including anything in checkout forms.
- Credentials of any kind.
- Payment fields.
- Cookies.
- `localStorage` or any other page-side storage.
- Page text beyond what an adapter's structural match needs to compute a progress ratio (e.g.
  the shipped adapter reads a `<progress>` element's `value`/`max` attributes — it does not read
  or forward surrounding page text).
- URLs beyond the single target URL the user supplied and had validated against the allowlist.
- Browsing history.

## Where data lives

- **`chrome.storage.local`** holds the session (`id`, `url`, `state`, `requestedCount`, `tabIds`,
  `createdAt`, `updatedAt`, `seq`) — this needs to survive a service-worker restart so a reopened
  popup can recover, per `src/platform/chromeBrowser.ts`.
- **`chrome.storage.session`** holds the readings, when that storage area is available in the
  running Chrome version. Readings are moment-to-moment progress snapshots that become
  actively misleading once stale, so they deliberately live in the storage area that does not
  survive a full browser restart, rather than `storage.local`. `src/platform/chromeBrowser.ts`
  falls back to `storage.local` for readings only if `chrome.storage.session` genuinely isn't
  available in that context — still better than losing the mid-session UI, but worth knowing if
  you're auditing exactly where bytes land on a given Chrome version.
- **Nothing leaves the machine.** There is no backend this extension talks to, no analytics
  collection, and no network request made by the extension's own code — the only network traffic
  it causes is the browser tabs it opens loading the queue page you asked it to monitor.

## Deleting your data

1. Click **Stop** in the popup. This ends the monitoring session (tabs stay open, per
   `AGENTS.md`'s "Stop never closes tabs" — Stop does not close your browser tabs for you).
2. Remove the extension from `chrome://extensions`. Uninstalling an extension clears the storage
   areas (`chrome.storage.local` and `chrome.storage.session`) that belong to it, which removes
   the session and reading data described above.

There is nowhere else this data could be — no account, no cloud copy, no backup — because there
is no backend to hold one.

## Permission justification

| Permission | Why it's requested |
| --- | --- |
| `tabs` | To open the tabs the user asked for (`chrome.tabs.create`), to read which tabs are still open for reconciliation (`chrome.tabs.query`), to message a tab's content script for a reading (`chrome.tabs.sendMessage`), and to focus a tab the user clicked Focus on (`chrome.tabs.update`). |
| `storage` | To persist the session and readings locally as described above, so a reopened popup or a restarted service worker can recover state instead of starting over or losing track of open tabs. |
| `host_permissions` (`http://localhost/*`, `http://127.0.0.1/*`) | Scoped to exactly the loopback hosts in the shipped allowlist (`src/config/allowlist.ts`). This is what lets Chrome grant the content script injection and messaging needed to read the bundled test fixture (`mock-queue/`) — see [README.md "Allowlist"](../README.md#allowlist) for how (and why) this would be widened for a real, authorized site. |

No other permission is requested. There is no `<all_urls>` host permission, no `scripting`
permission beyond the statically declared `content_scripts` entry, and no `alarms`,
`notifications`, or `webRequest` permission.
