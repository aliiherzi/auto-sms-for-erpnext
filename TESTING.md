# Test it yourself before installing

Try the real program in **GitHub Codespaces**, a free temporary computer from GitHub that runs in your browser. It can reach WhatsApp and your ERPNext, so you can link a real number and receive real messages.

Your customers are safe while you test: **Test mode** is on, so customer and supplier messages go only to *your* number. The ERPNext user you create only reads.

## 1. Open it

**[Open in GitHub Codespaces](https://codespaces.new/aliiherzi/auto-sms-for-erpnext?quickstart=1)** → **Create codespace**, then wait 2–3 minutes.

When it's ready, the terminal at the bottom shows:

```
  Dashboard: https://….app.github.dev
  Password:  …
```

The dashboard usually opens in a new tab by itself. If not, open the **Ports** tab, find port **3000** and click the 🌐 globe icon.

## 2. Log in

Use the password from the terminal. It's also in the `.env` file.

## 3. Connect your ERPNext

In ERPNext:

1. **User → Add User**, for example `whatsapp-bot@yourcompany.com`
2. Roles: **Accounts User, Sales User, Purchase User, Stock User**
3. Open the user → **Settings → API Access → Generate Keys**, then copy the key and secret

In the dashboard:

1. **Settings → ERPNext connection**: your ERPNext address, API key and secret → **Test connection**
2. **Settings → General**:
   - **Default country code** (digits only, e.g. `252`, `971`, `254`)
   - keep **Test mode** ticked
   - **Test recipient**: your own WhatsApp number
3. **Save settings**

## 4. Link WhatsApp

On **Overview** you see a QR code.

- **Dashboard on a computer**: on your phone open **WhatsApp → Settings → Linked devices → Link a device** and scan it.
- **Dashboard on the same phone**: open **"Can't scan? Link with phone number instead"**, enter your number and press **Get pairing code**. Then in WhatsApp go to **Linked devices → Link a device → Link with phone number instead** and type the code.

Use a business or test number if you have one.

## 5. Send a test message

**Tools → Send a test message**: choose your number or one of your groups → **Send**. It arrives on your phone in a few seconds.

## 6. Test an invoice

1. **Settings → Companies & WhatsApp numbers**: tick a group under *Copies of customer invoices go to* → **Save settings**
2. In ERPNext, **submit a new Sales Invoice** for any customer.
3. Within a minute (or press **Tools → Check for new invoices**):
   - **your** WhatsApp gets the customer message with the PDF, marked *TEST MODE – this would be sent to …*
   - the group gets the short copy
4. **Activity** lists every message and its status.

Only invoices submitted after you connected are sent automatically. To try an older one, use **Tools → Send an invoice now**.

## 7. Test the reports

**Overview → Scheduled reports → Preview** shows the message; **Send now** sends it to the group.

## 8. Optional: a second number

**Overview → Add another WhatsApp number**, then link it the same way. In **Settings → Companies & WhatsApp numbers**, choose which company uses it.

## When you're done

- The test computer **stops by itself** after 30 minutes without use, and nothing is sent while it's stopped. It's for testing only.
- To remove it: go to **github.com/codespaces** → **⋯** next to it → **Delete**. Then on your phone: **WhatsApp → Linked devices** → remove the device.
- GitHub gives free Codespaces hours every month; a test like this uses about an hour.
- For daily use, install it on your server: README → *Install it on your server*. You set it up there again; it takes about 5 minutes.
