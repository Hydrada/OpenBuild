# Document viewer/editor integration (design, Milestone 5)

OpenBuild owns *records* (drawings, revisions, RFIs, submittals, approvals). Markup and PDF editing belong to
separate tools: OpenDraft (Bluebeam alternative, published) and the in-progress Acrobat alternative.
OpenBuild talks to them through one adapter contract, so neither repository needs OpenBuild-specific code.

```ts
interface DocumentToolAdapter {
  id: string;                         // "opendraft", "acrobat-alt"
  capabilities: Array<"view" | "markup" | "compare" | "takeoff" | "edit" | "sign">;
  /** URL or deep link that opens `file` in the tool, with a callback to return results. */
  openUrl(file: { downloadUrl: string; name: string; revisionId: string }, callback: { uploadUrl: string; token: string }): string;
}
```

Flow:
1. User clicks **Open in OpenDraft** on a drawing revision.
2. OpenBuild mints a short-lived, single-revision download URL and an upload token (scoped: one file, one project, expires).
3. The tool saves the marked-up PDF back to `uploadUrl`; OpenBuild stores it as a new *markup set* on that revision
   (never overwriting the original) and writes an audit entry.
4. Markups can be linked to RFIs / punch items by id.

Constraints: tools never receive a user session cookie, only the scoped token; uploads are virus-scanned/size-limited;
the original sheet is immutable.
