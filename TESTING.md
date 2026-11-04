# Test it yourself before installing

Run the real program on **your own computer** and open it at **http://localhost:3000**. It talks to your real WhatsApp and your real ERPNext, so you see exactly what you'll get on the server.

Your customers are safe while you test: **Test mode** is on, so customer and supplier messages go only to *your* number. The ERPNext user you create only reads.

## 1. Start it on your computer

### Windows

1. Install **Node.js** (the **LTS** button) from **https://nodejs.org**: Next → Next → Finish.
2. Open **https://github.com/aliiherzi/auto-sms-for-erpnext** → green **Code** button → **Download ZIP**. Right-click the ZIP → **Extract All**.
3. In the extracted folder, double-click **`start-windows.bat`**. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**.
4. The first time it installs for 2–3 minutes. Then your browser opens **http://localhost:3000**, and the black window shows your **password**.

### Mac

1. Install **Node.js** (the **LTS** button) from **https://nodejs.org**.
2. Open **https://github.com/aliiherzi/auto-sms-for-erpnext** → green **Code** button → **Download ZIP**, then double-click the ZIP to unzip it.
3. Open **Terminal**, type `cd ` (with a space after it), drag the unzipped folder into the Terminal window and press **Enter**. Then type:

   ```bash
   sh start.sh
   ```

4. Your browser opens **http://localhost:3000**, and Terminal shows your **password**.

**Keep that window open while you test.** Messages are only sent while it runs and the computer is awake. If port 3000 is busy on your computer, it uses 3001 (or the next free port) and opens that instead.

<details>
<summary>No computer handy? Use GitHub Codespaces instead (runs in the browser)</summary>

**[Open in GitHub Codespaces](https://codespaces.new/aliiherzi/auto-sms-for-erpnext?quickstart=1)** → **Create codespace**, wait 2–3 minutes. The terminal shows the dashboard link and password; the **Ports** tab → port **3000** → 🌐 opens it. It stops by itself after 30 minutes without use.

</details>

## 2. Log in

Use the password from the window. It's also in the `.env` file in the folder.

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

On **Overview** you see a QR code. On your phone open **WhatsApp → Settings → Linked devices → Link a device** and scan it.

If the dashboard is open on the same phone you're linking, use **"Can't scan? Link with phone number instead"** and type the 8-character code in WhatsApp (**Linked devices → Link a device → Link with phone number instead**).

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

- Stop it: close the window (or press **Ctrl+C**). To start again later, double-click `start-windows.bat` or run `sh start.sh`. Your settings and WhatsApp link are kept in the `data` folder.
- To remove everything, delete the folder, then on your phone go to **WhatsApp → Linked devices** and remove the device.
- For daily use, install it on your server: README → *Install it on your server*. You set it up there again; it takes about 5 minutes.
