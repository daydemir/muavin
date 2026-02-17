import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function escapeAS(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

async function runAS(script: string, timeoutMs = 30000, lang?: "JavaScript"): Promise<string> {
  const args = lang ? ["osascript", "-l", lang, "-e", script] : ["osascript", "-e", script];
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timer);
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.trim() || "applescript failed");
  return stdout.trim();
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true as const };
}

/** convert ISO date string to AppleScript date literal */
function isoToAS(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error(`invalid date: ${iso}`);
  // AppleScript: date "month day, year hour:min:sec"
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const mo = months[d.getMonth()];
  const day = d.getDate();
  const yr = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `date "${mo} ${day}, ${yr} ${hh}:${mm}:${ss}"`;
}

/** parse RS-delimited rows (ASCII 30) into arrays of objects */
function parseRows(raw: string, keys: string[]): Record<string, string>[] {
  if (!raw) return [];
  return raw.split("\r").filter(Boolean).map((line) => {
    const parts = line.split("\x1E");
    const obj: Record<string, string> = {};
    keys.forEach((k, i) => { obj[k] = (parts[i] ?? "").trim(); });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "muavin-apple", version: "1.0.0" });

// ===========================================================================
// MAIL
// ===========================================================================

server.tool("mail_accounts", "list all email accounts", {}, async () => {
  try {
    const raw = await runAS(`
tell application "Mail"
  set out to ""
  repeat with a in every account
    set out to out & name of a & (ASCII character 30) & (email addresses of a as string) & return
  end repeat
  return out
end tell`);
    return ok(parseRows(raw, ["name", "email"]));
  } catch (e: unknown) { return err(String(e)); }
});

server.tool("mail_mailboxes", "list mailboxes for an account", { account: z.string() }, async ({ account }) => {
  try {
    const raw = await runAS(`
tell application "Mail"
  set out to ""
  repeat with mb in every mailbox of account "${escapeAS(account)}"
    set out to out & name of mb & return
  end repeat
  return out
end tell`);
    const names = raw.split("\r").filter(Boolean).map((n) => n.trim());
    return ok(names);
  } catch (e: unknown) { return err(String(e)); }
});

server.tool(
  "mail_search",
  "search emails (metadata only)",
  {
    query: z.string().optional(),
    account: z.string().optional(),
    mailbox: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ query, account, mailbox, limit }) => {
    try {
      const mb = mailbox ?? "INBOX";
      const lim = limit ?? 20;
      const acctClause = account ? `of account "${escapeAS(account)}"` : "";
      const filterLines = query
        ? `if (subject of m contains "${escapeAS(query)}") or (sender of m contains "${escapeAS(query)}") then
              set out to out & id of m & (ASCII character 30) & subject of m & (ASCII character 30) & sender of m & (ASCII character 30) & (date received of m as string) & (ASCII character 30) & (read status of m as string) & return
              set cnt to cnt + 1
              if cnt >= ${lim} then exit repeat
            end if`
        : `set out to out & id of m & (ASCII character 30) & subject of m & (ASCII character 30) & sender of m & (ASCII character 30) & (date received of m as string) & (ASCII character 30) & (read status of m as string) & return
            set cnt to cnt + 1
            if cnt >= ${lim} then exit repeat`;
      const raw = await runAS(`
tell application "Mail"
  set out to ""
  set cnt to 0
  repeat with m in (messages of mailbox "${escapeAS(mb)}" ${acctClause})
    ${filterLines}
  end repeat
  return out
end tell`, 60000);
      return ok(parseRows(raw, ["id", "subject", "sender", "date", "read"]));
    } catch (e: unknown) { return err(String(e)); }
  },
);

server.tool(
  "mail_read",
  "read full email content",
  {
    messageId: z.number(),
    account: z.string(),
    mailbox: z.string(),
  },
  async ({ messageId, account, mailbox }) => {
    try {
      const raw = await runAS(`
tell application "Mail"
  set m to (first message of mailbox "${escapeAS(mailbox)}" of account "${escapeAS(account)}" whose id is ${messageId})
  set attNames to ""
  repeat with a in (mail attachments of m)
    set attNames to attNames & name of a & ","
  end repeat
  return subject of m & (ASCII character 30) & sender of m & (ASCII character 30) & (address of every to recipient of m as string) & (ASCII character 30) & (date received of m as string) & (ASCII character 30) & (content of m as string) & (ASCII character 30) & attNames
end tell`);
      const parts = raw.split("\x1E");
      return ok({
        subject: parts[0] ?? "",
        sender: parts[1] ?? "",
        recipients: parts[2] ?? "",
        date: parts[3] ?? "",
        body: parts.slice(4, -1).join("\x1E"),
        attachments: (parts.at(-1) ?? "").split(",").filter(Boolean),
      });
    } catch (e: unknown) { return err(String(e)); }
  },
);

server.tool(
  "mail_archive",
  "archive an email",
  {
    messageId: z.number(),
    account: z.string(),
    mailbox: z.string(),
  },
  async ({ messageId, account, mailbox }) => {
    try {
      // find archive mailbox for this account
      const mbRaw = await runAS(`
tell application "Mail"
  set out to ""
  repeat with mb in every mailbox of account "${escapeAS(account)}"
    set out to out & name of mb & return
  end repeat
  return out
end tell`);
      const mbNames = mbRaw.split("\r").filter(Boolean).map((n) => n.trim());
      const archiveName = mbNames.find((n) =>
        /^archive$/i.test(n) || /^all mail$/i.test(n) || /all mail/i.test(n)
      );
      if (!archiveName) return err(`no archive mailbox found for account "${account}". available: ${mbNames.join(", ")}`);

      await runAS(`
tell application "Mail"
  set m to (first message of mailbox "${escapeAS(mailbox)}" of account "${escapeAS(account)}" whose id is ${messageId})
  set targetMb to mailbox "${escapeAS(archiveName)}" of account "${escapeAS(account)}"
  move m to targetMb
end tell`);
      return ok({ archived: true, destination: archiveName });
    } catch (e: unknown) { return err(String(e)); }
  },
);

server.tool(
  "mail_draft_create",
  "create an email draft",
  {
    to: z.string(),
    subject: z.string(),
    body: z.string(),
    account: z.string().optional(),
    cc: z.string().optional(),
  },
  async ({ to, subject, body, account, cc }) => {
    try {
      const acctProp = account ? `, sender:"${escapeAS(account)}"` : "";
      const ccBlock = cc
        ? `make new cc recipient at end of cc recipients of newMsg with properties {address:"${escapeAS(cc)}"}`
        : "";
      await runAS(`
tell application "Mail"
  set newMsg to make new outgoing message with properties {subject:"${escapeAS(subject)}", content:"${escapeAS(body)}", visible:false${acctProp}}
  make new to recipient at end of to recipients of newMsg with properties {address:"${escapeAS(to)}"}
  ${ccBlock}
  save newMsg
end tell`);
      return ok({ drafted: true, to, subject });
    } catch (e: unknown) { return err(String(e)); }
  },
);

// ===========================================================================
// NOTES
// ===========================================================================

server.tool(
  "notes_search",
  "search notes",
  {
    query: z.string(),
    folder: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ query, folder, limit }) => {
    try {
      const lim = limit ?? 20;
      const folderClause = folder ? `of folder "${escapeAS(folder)}"` : "";
      const raw = await runAS(`
tell application "Notes"
  set out to ""
  set cnt to 0
  repeat with n in every note ${folderClause}
    if name of n contains "${escapeAS(query)}" or plaintext of n contains "${escapeAS(query)}" then
      set ptext to plaintext of n
      if length of ptext > 100 then
        set snip to text 1 thru 100 of ptext
      else
        set snip to ptext
      end if
      set out to out & id of n & (ASCII character 30) & name of n & (ASCII character 30) & (name of container of n) & (ASCII character 30) & snip & (ASCII character 30) & (modification date of n as string) & return
      set cnt to cnt + 1
      if cnt >= ${lim} then exit repeat
    end if
  end repeat
  return out
end tell`, 60000);
      return ok(parseRows(raw, ["id", "title", "folder", "snippet", "modified"]));
    } catch (e: unknown) { return err(String(e)); }
  },
);

server.tool(
  "notes_read",
  "read a note",
  { noteId: z.string() },
  async ({ noteId }) => {
    try {
      const raw = await runAS(`
tell application "Notes"
  set n to note id "${escapeAS(noteId)}"
  return name of n & (ASCII character 30) & (plaintext of n) & (ASCII character 30) & (name of container of n) & (ASCII character 30) & (creation date of n as string) & (ASCII character 30) & (modification date of n as string)
end tell`);
      const parts = raw.split("\x1E");
      return ok({
        title: parts[0] ?? "",
        body: parts.slice(1, -3).join("\x1E"),
        folder: parts.at(-3) ?? "",
        created: parts.at(-2) ?? "",
        modified: parts.at(-1) ?? "",
      });
    } catch (e: unknown) { return err(String(e)); }
  },
);

server.tool(
  "notes_create",
  "create a note in the mua folder",
  {
    title: z.string(),
    body: z.string(),
  },
  async ({ title, body }) => {
    try {
      await runAS(`
tell application "Notes"
  make new note at folder "mua" with properties {name:"${escapeAS(title)}", body:"${escapeAS(body)}"}
end tell`);
      return ok({ created: true, title, folder: "mua" });
    } catch (e: unknown) { return err(String(e)); }
  },
);

// ===========================================================================
// CALENDAR
// ===========================================================================

server.tool("calendar_calendars", "list all calendars", {}, async () => {
  try {
    const raw = await runAS(`
tell application "Calendar"
  set out to ""
  repeat with c in every calendar
    set acctName to ""
    try
      set acctName to name of account of c
    end try
    set out to out & name of c & (ASCII character 30) & acctName & return
  end repeat
  return out
end tell`);
    return ok(parseRows(raw, ["name", "account"]));
  } catch (e: unknown) { return err(String(e)); }
});

server.tool(
  "calendar_list",
  "list events in a date range",
  {
    startDate: z.string(),
    endDate: z.string(),
    calendar: z.string().optional(),
  },
  async ({ startDate, endDate, calendar }) => {
    try {
      const calClause = calendar
        ? `of calendar "${escapeAS(calendar)}"`
        : "";
      const calFilter = calendar ? `if (cal.name() !== "${escapeAS(calendar)}") continue;` : "";
      const raw = await runAS(`
var app = Application("Calendar");
var startD = new Date("${escapeAS(startDate)}");
var endD = new Date("${escapeAS(endDate)}");
var cals = app.calendars();
var RS = String.fromCharCode(30);
var out = [];
for (var i = 0; i < cals.length; i++) {
  var cal = cals[i];
  ${calFilter}
  try {
    var evts = cal.events();
    for (var j = 0; j < evts.length; j++) {
      var e = evts[j];
      var eStart = e.startDate().getTime();
      if (eStart < startD.getTime() || eStart > endD.getTime()) continue;
      var loc = "";
      try { loc = e.location() || ""; } catch(x) {}
      out.push(e.summary() + RS + e.startDate().toString() + RS + e.endDate().toString() + RS + loc + RS + cal.name());
    }
  } catch(x) {}
}
out.join("\\r");`, 60000, "JavaScript");
      return ok(parseRows(raw, ["title", "start", "end", "location", "calendar"]));
    } catch (e: unknown) { return err(String(e)); }
  },
);

server.tool(
  "calendar_create",
  "create a calendar event",
  {
    title: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    calendar: z.string().optional(),
    location: z.string().optional(),
    notes: z.string().optional(),
  },
  async ({ title, startDate, endDate, calendar, location, notes }) => {
    try {
      const cal = calendar ?? "Calendar";
      const locProp = location ? `, location:"${escapeAS(location)}"` : "";
      const notesProp = notes ? `, description:"${escapeAS(notes)}"` : "";
      await runAS(`
tell application "Calendar"
  tell calendar "${escapeAS(cal)}"
    make new event with properties {summary:"${escapeAS(title)}", start date:${isoToAS(startDate)}, end date:${isoToAS(endDate)}${locProp}${notesProp}}
  end tell
end tell`);
      return ok({ created: true, title, start: startDate, end: endDate });
    } catch (e: unknown) { return err(String(e)); }
  },
);

// ===========================================================================
// REMINDERS
// ===========================================================================

server.tool("reminders_lists", "list all reminder lists", {}, async () => {
  try {
    const raw = await runAS(`
tell application "Reminders"
  set out to ""
  repeat with l in every list
    set out to out & name of l & return
  end repeat
  return out
end tell`);
    const names = raw.split("\r").filter(Boolean).map((n) => n.trim());
    return ok(names);
  } catch (e: unknown) { return err(String(e)); }
});

server.tool(
  "reminders_search",
  "search reminders",
  {
    list: z.string().optional(),
    completed: z.boolean().optional(),
    limit: z.number().optional(),
  },
  async ({ list, completed, limit }) => {
    try {
      const lim = limit ?? 20;
      const comp = completed ?? false;
      const listClause = list ? `of list "${escapeAS(list)}"` : "";
      const raw = await runAS(`
tell application "Reminders"
  set out to ""
  set cnt to 0
  repeat with r in (every reminder ${listClause} whose completed is ${comp})
    set dd to ""
    try
      set dd to (due date of r as string)
    end try
    set ln to ""
    try
      set ln to name of container of r
    end try
    set out to out & id of r & (ASCII character 30) & name of r & (ASCII character 30) & dd & (ASCII character 30) & (completed of r as string) & (ASCII character 30) & ln & return
    set cnt to cnt + 1
    if cnt >= ${lim} then exit repeat
  end repeat
  return out
end tell`, 60000);
      return ok(parseRows(raw, ["id", "title", "dueDate", "completed", "list"]));
    } catch (e: unknown) { return err(String(e)); }
  },
);

server.tool(
  "reminders_create",
  "create a reminder",
  {
    title: z.string(),
    list: z.string().optional(),
    dueDate: z.string().optional(),
    notes: z.string().optional(),
  },
  async ({ title, list, dueDate, notes }) => {
    try {
      const listName = list ?? "Inbox";
      const dueProp = dueDate ? `, due date:${isoToAS(dueDate)}` : "";
      const notesProp = notes ? `, body:"${escapeAS(notes)}"` : "";
      await runAS(`
tell application "Reminders"
  tell list "${escapeAS(listName)}"
    make new reminder with properties {name:"${escapeAS(title)}"${dueProp}${notesProp}}
  end tell
end tell`);
      return ok({ created: true, title, list: listName });
    } catch (e: unknown) { return err(String(e)); }
  },
);

server.tool(
  "reminders_complete",
  "mark a reminder as complete",
  {
    reminderId: z.string(),
    list: z.string(),
  },
  async ({ reminderId, list }) => {
    try {
      await runAS(`
tell application "Reminders"
  tell list "${escapeAS(list)}"
    set r to (first reminder whose id is "${escapeAS(reminderId)}")
    set completed of r to true
  end tell
end tell`);
      return ok({ completed: true, reminderId });
    } catch (e: unknown) { return err(String(e)); }
  },
);

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
