# Deck converter runbook

Turns Office documents (`.pptx`, `.ppt`) into PDF so the app can show them as slides. The render
pipelines only understand PDF, so without this, PowerPoint uploads do not work.

It is a separate Cloud Run service running the stock [Gotenberg](https://gotenberg.dev) image,
which is LibreOffice in a container. It is kept out of the main app image deliberately: the app
stays small, and LibreOffice can be slow or crash without taking the app with it.

Since issue #182 it is the only office-conversion path we have. LibreOffice was removed from the
app image for a security reason. A crafted PPTX can make LibreOffice resolve external links. When
that ran in-process, it meant the app container could be made to fetch its own metadata endpoint
or reach internal services, and it handed an attacker a CPU and memory lever inside a request.

Three callers use it, and they do not get the same time budget:

| Caller | Path | Request budget |
|---|---|---|
| Live Classroom decks | `ensurePdf` | 900s route, client default 120s |
| Chat and assistant uploads | `convertOfficeToPdf` | 120s routes, passes **100s** |
| Citation previews and extraction | `document-parser/office-to-pdf.ts` | 60s route, passes **45s** |

So a conversion that is fine for a deck upload can still time out on a citation preview. That is
deliberate. The route would die at 60s anyway.

```
prof uploads .pptx ──▶ stored in Supabase ──▶ render-deck route downloads it
                                                     │
                                       ensurePdf() ──▶ POST {GOTENBERG_URL}/forms/libreoffice/convert
                                                     │   (Authorization: Bearer <Google ID token>)
                                                     ◀── PDF bytes
                                       existing pdfjs render + extraction (unchanged)
```

**Auth.** The converter is IAM-locked (`--no-allow-unauthenticated`). The app gets a Google ID
token from the Cloud Run metadata server, with the audience set to the converter's URL. There is
no shared secret, so there is nothing to rotate.

**If it goes down, nothing breaks.** When `GOTENBERG_URL` is not set on the app, the PowerPoint
upload option is hidden and PDF works exactly as before. A converter outage makes PPTX
temporarily unavailable, nothing more.

---

## First-time setup

```bash
# 1. Deploy the converter (public image, IAM-locked).
bash infra/microservices/deck-converter/deploy.sh
#    → prints the converter URL, e.g. https://scholera-deck-converter-XXXX.a.run.app

# 2. Find the runtime service account of the MAIN app service.
gcloud run services describe scholera --region us-central1 \
  --format="value(spec.template.spec.serviceAccountName)"
#    → e.g. 123456789-compute@developer.gserviceaccount.com  (the default if unset)

# 3. Let that service account call the converter.
gcloud run services add-iam-policy-binding scholera-deck-converter \
  --region us-central1 \
  --member="serviceAccount:<APP_SERVICE_ACCOUNT>" \
  --role="roles/run.invoker"

# 4. Tell the app where the converter is. This is a separate step because the
#    deploy script never touches environment variables.
gcloud run services update scholera --region us-central1 \
  --update-env-vars GOTENBERG_URL=<CONVERTER_URL>
#    Do NOT set GOTENBERG_SKIP_AUTH in prod. Leaving it unset keeps ID-token auth on.

# 5. Check it, signed in as a professor or admin:
#    GET https://<app>/api/live-classroom/converter-health  → { enabled:true, ok:true, status:200 }
```

Once that is done, the upload dialog shows the "Upload File" tab and PowerPoint module items, and
PPTX uploads convert without the user noticing.

---

## Running it locally

```bash
# Host port 3001 — next dev already holds 3000.
docker run --rm -p 3001:3000 gotenberg/gotenberg:8
```

Then in `.env.local`:

```
GOTENBERG_URL=http://localhost:3001
GOTENBERG_SKIP_AUTH=true     # local Gotenberg has no auth, so skip the ID-token fetch
```

---

## Checking on it

**Is it wired up?** `GET /api/live-classroom/converter-health` (professor or admin only) returns
`{ enabled, ok, status, ms }`. `enabled:false` means `GOTENBERG_URL` is not set on the app.

**What has it converted?** Filter the main app's Cloud Run logs for `deckConverter.`, which logs
each attempt with duration and byte count. The events table also records
`lc_room.deck_convert_succeeded` and `lc_room.deck_convert_failed`.

**The converter's own logs:**

```bash
gcloud run services logs read scholera-deck-converter --region us-central1 --limit 100
```

## Rolling back

```bash
# List revisions, then send all traffic back to the last good one.
gcloud run revisions list --service scholera-deck-converter --region us-central1
gcloud run services update-traffic scholera-deck-converter \
  --region us-central1 --to-revisions=<PREVIOUS_REVISION>=100
```

Unsetting the variable reaches further than it used to. With LibreOffice gone from the app image
there is no local fallback, so it also stops citation previews rendering for `.pptx` and `.ppt`,
which show "couldn't render". It is not just PowerPoint upload that stops. PDFs are unaffected,
and any derived PDF already cached keeps working, because it is stored beside the original.

To switch Office conversion off immediately, remove the variable from the app:

```bash
gcloud run services update scholera --region us-central1 --remove-env-vars GOTENBERG_URL
```

The app drops back to PDF-only cleanly.

## When something goes wrong

| What you see | Usually means | What to do |
|---|---|---|
| Health route says `enabled:false` | `GOTENBERG_URL` is not set on the app | Set it. See step 4. |
| Conversion fails, app logs a `401` or `403` | The IAM grant is missing, or the ID-token audience does not match the converter URL | Re-run step 3, and check `GOTENBERG_URL` is the exact service URL. |
| Professor sees `deck_failed: convert` and a `413` | The PPTX is over 30 MB | Working as intended. Tell them to export to PDF, which allows 250 MB. |
| Conversions hang or time out under load | Converter concurrency is above 1 | Redeploy. `--concurrency 1` is required, because LibreOffice is single-threaded. |
| A `.pptx` citation preview says "couldn't render" | `GOTENBERG_URL` is unset on the app, and since #182 there is no local fallback | Set it. See step 4, then check `/api/live-classroom/converter-health`. |
| A preview times out but the same deck converts fine for Live Classroom | Expected. The preview path caps at 45s to stay under its 60s route | Nothing to fix. The derived PDF is cached on the first success. |
| Fonts or layout look wrong in the slides | LibreOffice substituted a font it did not have | The stock image covers the metric-compatible ones (Carlito, Caladea, Liberation). If professors keep reporting drift, build a custom image `FROM gotenberg/gotenberg:8-cloudrun` with the fonts added, and point `IMAGE` in `deploy.sh` at it. |
| The first conversion of the day times out | Cold start plus LibreOffice startup | Set `MIN_INSTANCES=1` in `deploy.sh` and redeploy. Costs a little to keep one instance warm. |

## Cost

It scales to zero, so you only pay while a conversion is actually running, which is seconds per
deck. Hundreds of conversions a day cost cents. Only raise `MIN_INSTANCES` above zero if cold
starts become a real complaint.
