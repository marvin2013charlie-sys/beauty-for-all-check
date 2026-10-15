# Beauty For All login

A responsive admin and staff login using the colours, branding, typography and rounded panels of the supplied dashboard reference. A blue brand panel sits on the left; an Admin/Staff selector on the right displays only the selected four-digit PIN form, with paste support, automatic digit focus, keyboard controls, PIN visibility, inline errors and accessible help.

## Run locally

Requires Node.js 22.13 or newer (with built-in SQLite support). No package installation is needed.

```sh
npm start
```

Open http://127.0.0.1:4187. Initial random admin and staff PINs are written to `.local/LOCAL_ACCESS.txt` on first run. This owner-only handover file is never served over HTTP and can be deleted once the PINs are recorded. Authentication uses separate salted scrypt hashes in `.local/credentials.json`, not credentials embedded in browser code.

To generate replacement PINs, stop the server, run `npm run reset-pins`, read the new local handover file, and restart. Sessions expire after four hours and are cleared when the process stops. Incorrect PIN attempts are rate limited.

```sh
npm test
```

## Workspace

The blue-and-white admin dashboard now uses a local SQLite database at `.local/salon.sqlite`. Staff Mode opens a day calendar with one column per active Staff record. Staff names are scheduling resources, not login accounts. Staff can create and reschedule appointments, select multiple services, mark arrivals, start appointments, add extra services, check out, record walk-in sales and print or reopen receipts. Admin includes those workflows and management of staff, services, products and stock, sales, cash-ups, reports, audit history and business settings. Admin can also enter Staff Mode from the toolbar.

- Catalogues and records start empty. Enter approved service/product prices and real opening stock.
- Sales use integer pence and support cash and card payments, cash received/change and staff attribution. Recording a card payment requires confirmation that it was already taken on an external terminal; the app does not charge or refund cards.
- Product sales reduce stock. Editing or deleting a sale adjusts stock within the same database transaction. Deleting a sale does not physically refund money.
- Appointment payments retain booked service prices, prevent duplicate checkout, and mark the appointment Paid; Mark completed records the separate completion step. Overlapping appointments for the same staff member are rejected.
- Dashboard and reports show sales totals, cash/card totals, staff attribution and daily/weekly/monthly revenue. Weeks start Monday; dates use Europe/London. CSV export is available for the selected report period.
- Staff cash-up shows the selected day’s cash sales, cash refunds, expected cash, actual cash and over/short. It records the named person, timestamp and notes. Business revenue reports, staff earnings and audit remain admin-only.
- Cash-ups compare opening float plus cash sales with counted cash. Saving a cash-up closes that date to sales changes; an admin can delete the cash-up to reopen it.
- Edits use version checks to avoid overwriting another user's changes. Deletions are soft deletions. Audit history retains before/after values, is not editable, and the screen shows the latest 500 changes. Because login uses two shared PINs, the audit actor is Admin or Staff, not an individually authenticated employee.
- Customer, staff and service deletion is blocked when an active appointment depends on the record. Products with recorded sales must remain available for stock corrections. Paid appointments must be corrected through their linked sale before editing/deletion.

The old `/admin/design` address redirects to the working admin dashboard. `public/` contains the login and workspace interfaces; `store.mjs` handles database validation, calculations and audit writes. The browser acceptance data uses a separate temporary database, never the live `.local/` database.

## Running and verification

`npm start` binds only to `127.0.0.1:4187`. On Render the same process binds to `0.0.0.0` on Render’s port and marks the sign-in cookie Secure. `render.yaml` publishes a free check service at Render’s own `onrender.com` address, with no custom domain. That free service does not keep bookings after a restart. Receipt printing uses the browser print dialog. The salon printer stays on the local network and is not reached from Render. No payment provider is configured. Back up the SQLite database with an SQLite-aware backup tool or stop the app before copying the data directory.

`npm test` checks login, role enforcement, persistence across restart, appointment overlap, exact payment amounts, stock rollback/corrections, duplicate-payment prevention, cash-ups and audit retention with isolated databases. Google Fonts has system font fallbacks.

## Customer and appointment records

Staff records use a name and an active/inactive calendar control; no job title or individual account is needed. Customer profiles include full name, mobile, optional email, notes and linked appointment, service, payment and product purchase histories.

Appointments store a mobile contact, number of people, date/time, assigned staff, multiple services and notes. Service selections calculate duration and price; group size is informational and does not multiply either. Statuses are Booked, Arrived, Started, Awaiting Payment, Paid, Completed, Cancelled and No-show. No-shows and cancellations release their time slot. Paid is set by checkout, and paid bookings can then be marked Completed.

Record deposit on a saved appointment records cash/card already received, with a receipt and payment history. Deposits reduce checkout's remaining balance and appear in cash-up/report figures on their payment date; the final checkout records only the remaining money collected. Deposits cannot exceed the appointment price, and a linked final checkout must be corrected before an admin changes/deletes a deposit. Recording or deleting a payment does not actually charge or refund a card.

## Working hours, receipts and till

In Admin → Staff → Working hours, configure each weekday’s start/end, or leave both blank for a day off. These are separate scheduling records; staff still only need a name and active flag. No real hours are prefilled. New appointments, rescheduling and duration changes require configured hours and must fit entirely within the assigned staff member’s working period. Overlaps are rejected on the server. Existing bookings must be rescheduled before narrowing hours around them. Staff can cancel and soft-delete unpaid appointments; bookings linked to payments remain protected.

NEW SALE supports services/products, a staff assignment per item, an existing/new/anonymous customer, discounts, cash change and confirmed external-terminal card payments. Subtotal, discount, total, deposit and remaining payment are shown separately. Every completed payment has a permanent BFA receipt number allocated in SQLite; deleting a sale does not free its number. Receipts include the supplied salon address, transaction timestamp, staff, customer, item unit prices/quantities, totals, method and thank-you message. Prior payments receive permanent numbers on first startup with this version. Keep the database when migrating the app to retain numbering.

Admin → Total sales → Record refund records money actually returned, with receipt link, amount, method and reason. It cannot exceed the original payment for that method. Cash refunds reduce expected cash on their refund date. This does not send money through a card terminal or change product stock.

### Future drawer adapter

The default server has no hardware adapter. A future trusted server-side printer/cash-drawer integration can be passed to `createApp({ drawer })` with an asynchronous `drawer.open({ key, reason })` method. That adapter must implement the selected printer/driver’s supported drawer pulse command. Do not expose the device or an unrestricted open endpoint to the browser. Printer compatibility, connection/driver setup, physical printing and actual drawer movement are not verified.

A completed cash payment is committed before the server requests a drawer command. Failed payments, card payments, receipt printing and edits never request opening. Each payment request is handled once; retries do not open again. Disconnected/failed requests are logged and never replayed automatically when hardware is connected later. A crash between committing the sale and sending a command may leave the drawer closed; an admin can issue a reasoned manual request. Admin → Settings → Manual drawer opening requires a reason and records both request and outcome in Audit log. A successful adapter result means command sent, not proof of physical movement.
