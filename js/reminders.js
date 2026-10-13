// reminders.js — "you haven't backed up in a while" banner + calendar reminder file.

const DAY = 86_400_000;

/** Work out which reminders to show. Returns a list of short messages (may be empty). */
export function dueReminders({ lastBackupAt, lastImportAt, hasData, reminderDays }) {
  const now = Date.now();
  const msgs = [];
  const ago = (t) => Math.floor((now - t) / DAY);

  if (!lastImportAt) {
    msgs.push({ kind: 'import', text: 'No Scoria data imported yet.' });
  } else if (now - lastImportAt > reminderDays * DAY) {
    msgs.push({ kind: 'import', text: `Last Scoria import ${ago(lastImportAt)} days ago.` });
  }
  if (hasData) {
    if (!lastBackupAt) msgs.push({ kind: 'backup', text: 'You have never made a backup.' });
    else if (now - lastBackupAt > reminderDays * DAY) {
      msgs.push({ kind: 'backup', text: `Last backup ${ago(lastBackupAt)} days ago.` });
    }
  }
  return msgs;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * A repeating calendar event (.ics) for the 1st of every month.
 * You add it to your calendar once; no server needed.
 */
export function buildMonthlyIcs() {
  const now = new Date();
  // Next 1st of the month, 10:00 local time ("floating" time = whatever zone you're in).
  const first = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const date = `${first.getFullYear()}${pad(first.getMonth() + 1)}${pad(first.getDate())}`;
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

  const description = [
    'Monthly Scratch Map routine:',
    '1. Scoria > Export database (.sqlite).',
    '2. Save that .sqlite to iCloud Drive (Files app) - keep the raw file safe!',
    '3. Open Scratch Map > Import > choose the file.',
    '4. Scratch Map > Backup > Save to Files (iCloud Drive).',
    '5. AirDrop / copy both files to your laptop.',
  ].join('\\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Scratch Map//Backup reminder//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:scratchmap-monthly-backup-${stamp}@scratchmap.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${date}T100000`,
    `DTEND:${date}T101500`,
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=1',
    'SUMMARY:Scratch Map: export Scoria + back up',
    `DESCRIPTION:${description}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Scratch Map backup',
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // Calendar files need Windows-style line endings and lines of max 75 bytes
  // ("folding"). The text above is plain ASCII so characters = bytes.
  const fold = (l) => {
    const out = [];
    while (l.length > 74) { out.push(l.slice(0, 74)); l = ' ' + l.slice(74); }
    out.push(l);
    return out.join('\r\n');
  };
  const text = lines.map(fold).join('\r\n') + '\r\n';
  return new File([text], 'scratchmap-monthly-reminder.ics', { type: 'text/calendar' });
}
