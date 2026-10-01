# Chat Components (Project Discussions)

Team-scoped real-time chat within project workspace. Students only — no professor access.

| File | Purpose |
|------|---------|
| `ChannelSidebar.tsx` | Left panel with channel list, create/rename/delete dialogs |
| `ChatArea.tsx` | Message feed with auto-scroll, infinite scroll upward, and input bar; loads team phase + doc titles for inline `@phase` / `@doc` chip rendering |
| `ChatInput.tsx` | Text input with Shift+Enter newline, file attachments, emoji, `@user`, `@phase`, and `@doc` mention picker |
| `MentionPicker.tsx` | Floating autocomplete with grouped sections (Teammates, Phases, Docs) |
| `MessageBubble.tsx` | Single message display — author info, text with `@user` pills + `@phase` / `@doc` hover chips, attachment preview |
| `PhaseMentionChip.tsx` | Inline `@phase` chip with HoverCard showing phase title, status, and checklist items |
| `DocMentionChip.tsx` | Inline `@doc` chip with HoverCard showing doc title, last-updated timestamp, and a short text excerpt |
| `SystemMessageLine.tsx` | Centered inline rendering for `kind='system'` lifecycle events (member_joined, doc_created, phase_assigned, phase_status_changed) |
