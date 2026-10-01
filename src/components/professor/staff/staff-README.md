# Professor Staff Components

| File | Purpose |
|------|---------|
| `StaffFeaturePage.tsx` | Top-level orchestrator — header, "Request" CTA, and unified Teaching Staff list. Normalizes active staff rows + pending/rejected requests into a single sorted feed |
| `SubmitStaffRequestDialog.tsx` | Form dialog where the professor enters candidate details (name, email, role, end date) and submits for admin approval |
| `StaffList.tsx` | Unified list that renders active members, pending candidates, and rejected requests as a single grid with status pills; pending rows get a "Withdraw" action |
