// Made-up data for trying the page without connecting anything: open index.html?demo
// Every date is relative to "now", so the demo always looks like today.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CODES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export function demoData(nowMs = Date.now()) {
  const day0 = new Date(nowMs);
  const at = (days, hour, minute = 0) => new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + days, hour, minute).toISOString();
  const ago = (hours) => new Date(nowMs - hours * HOUR).toISOString();
  const today = CODES[day0.getDay()];

  const item = (id, title, course, dueAt, over = {}) => ({ id: `canvas:${id}`, source: 'canvas', kind: 'assignment', title, course, dueAt, allDay: false, url: 'https://canvas.instructure.com/', firstSeen: ago(72), pastOnArrival: false, ...over });

  const site = {
    version: 1,
    generatedAt: ago(1.5),
    items: [
      item('1', 'Quiz 9: Contracts', 'LAW 210', at(0, 17)),
      item('2', 'Week 11 Article Summary', 'LAW 210', at(0, 23, 59)),
      item('3', 'Lab Report #3: Cell Respiration', 'BIO 110', at(-2, 23, 59)),
      item('4', 'Case Brief: Agency', 'LAW 210', at(1, 23, 59), { firstSeen: ago(1.5) }),
      item('5', 'Problem Set 6', 'ECON 202', at(2, 12), { changed: { from: at(1, 12), at: ago(1.5) } }),
      item('6', 'Reading Response: Chapter 9', 'HIST 105', at(3, 23, 59)),
      item('7', 'Exam 3', 'MATH 140', at(5, 9, 0), { kind: 'event' }),
      item('8', 'Homework 5: Elasticity', 'ECON 202', at(6, 23, 59), { firstSeen: ago(1.5) }),
      item('9', 'Discussion Post: Primary Sources', 'HIST 105', at(4, 23, 59), { gone: true }),
      item('10', 'Final Paper Draft', 'LAW 210', at(24, 23, 59)),
      item('11', 'Old Homework', 'BIO 110', at(-12, 23, 59), { pastOnArrival: true }),
    ],
    mail: [
      { id: 'mail:1', bucket: 'action', account: 'school', origin: 'mail', from: 'Dr. Ada Lee', fromAddr: 'axl100@university.example', subject: 'Exam 3 room change — please confirm', summary: 'Exam 3 moves to 110 Business Building; she wants a reply confirming you saw this.', task: 'Reply to Dr. Lee confirming Exam 3 room', due: at(1, 12).slice(0, 10), date: ago(3), link: 'https://mail.google.com/mail/', by: 'claude', reason: 'Direct school email that asks something of you', unread: true },
      { id: 'mail:2', bucket: 'action', account: 'school', origin: 'teams', from: 'Teams', fromAddr: 'noreply@email.teams.microsoft.com', subject: 'Sam mentioned you in Finance Committee', summary: 'Sam asks you to check the donation totals before tonight’s meeting.', task: 'Check donation totals for Sam', due: '', date: ago(1.8), link: 'https://mail.google.com/mail/', by: 'claude', reason: 'Someone reached out to you on Teams', unread: true },
      { id: 'mail:3', bucket: 'action', account: 'personal', origin: 'mail', from: 'Jordan Park', fromAddr: 'jordan@example.com', subject: 'Saturday?', summary: 'Jordan asks whether you can drive to the game Saturday and needs an answer by Thursday.', task: 'Tell Jordan about Saturday', due: '', date: ago(9), link: 'https://mail.google.com/mail/', by: 'claude', reason: 'A person wrote to you and seems to want a reply', unread: false },
      { id: 'mail:4', bucket: 'fyi', account: 'school', origin: 'canvas', from: 'Canvas', fromAddr: 'notifications@instructure.com', subject: 'Assignment Graded: Quiz 8, LAW 210', summary: 'Quiz 8 has been graded.', task: '', due: '', date: ago(5), link: 'https://mail.google.com/mail/', by: 'claude', reason: 'Canvas notification', unread: true },
      { id: 'mail:5', bucket: 'fyi', account: 'school', origin: 'mail', from: 'Registrar', fromAddr: 'registrar@university.example', subject: 'Spring scheduling opens Nov 18', summary: 'Your enrollment date for spring is November 18 at 7:00 AM.', task: '', due: '', date: ago(20), link: 'https://mail.google.com/mail/', by: 'claude', reason: 'School announcement', unread: false },
      { id: 'mail:6', bucket: 'fyi', account: 'personal', origin: 'mail', from: 'Mom', fromAddr: 'mom@example.com', subject: 'Thanksgiving plans', summary: 'Dinner is at 3 on Thursday; she’ll pick you up Wednesday afternoon.', task: '', due: '', date: ago(26), link: 'https://mail.google.com/mail/', by: 'claude', reason: 'A person wrote to you', unread: false },
    ],
    noise: [
      { id: 'mail:20', from: 'Campus Pizza', fromAddr: 'deals@pizza.example', subject: '2-for-1 tonight only', date: ago(2), by: 'rules', reason: 'Gmail filed it under Promotions' },
      { id: 'mail:21', from: 'LinkedIn', fromAddr: 'jobs@linkedin.example', subject: '12 new jobs for you', date: ago(6), by: 'rules', reason: 'Gmail filed it under Social' },
      { id: 'mail:22', from: 'University News', fromAddr: 'news@university.example', subject: 'This week on campus', date: ago(8), by: 'claude', reason: 'School announcement' },
      { id: 'mail:23', from: 'Textbook Rentals', fromAddr: 'hello@books.example', subject: 'Finals are coming — save 20%', date: ago(11), by: 'rules', reason: 'Gmail filed it under Promotions' },
      { id: 'mail:24', from: 'Streaming Co', fromAddr: 'news@stream.example', subject: 'New this week', date: ago(15), by: 'rules', reason: 'Automated or mailing-list mail' },
    ],
    schedule: {
      classes: [
        { course: 'MATH 140', days: [today], start: '09:00', end: '10:15', room: '204 North Hall' },
        { course: 'ECON 202', days: [today], start: '12:20', end: '13:35', room: '12 Science Center' },
        { course: 'LAW 210', days: [today], start: '15:30', end: '16:45', room: '310 Main Building' },
      ],
    },
    status: {
      lastRun: ago(1.5),
      sources: {
        canvas: { state: 'ok', lastSuccess: ago(1.5), count: 11 },
        gmail: { state: 'ok', lastSuccess: ago(1.5), count: 41 },
        school: { state: 'ok', lastMail: ago(3) },
        teams: { lastMail: ago(1.8) },
      },
      ai: { mode: 'cli', ok: true },
      warnings: [],
    },
  };

  const user = {
    version: 1,
    tasks: [
      { id: 'm:demo1', title: 'Email advisor about spring schedule', dueAt: at(0, 15), allDay: false, notes: '', course: '', priority: 'high', done: false, createdAt: ago(30) },
      { id: 'm:demo2', title: 'Buy poster board for club table', dueAt: null, allDay: false, notes: '', course: '', priority: 'normal', done: false, createdAt: ago(50) },
      { id: 'm:demo3', title: 'Return library book', dueAt: at(-1, 18), allDay: false, notes: '', course: '', priority: 'normal', done: true, doneAt: ago(20), createdAt: ago(90) },
    ],
    state: {},
    mail: {},
    senders: { '@pizza.example': 'noise' },
  };

  return { site, user, seenBefore: nowMs - DAY };
}
