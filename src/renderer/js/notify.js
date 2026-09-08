/* HR Dock — in-app reminder surface.
   The OS toast is fired by the main process; this adds the in-widget card with
   snooze / complete / open actions, and owns the chime so Silent mode is
   honoured in one place. */
(function (global) {
  'use strict';

  function iconFor(kind) {
    if (kind === 'birthday') return 'cake';
    if (kind === 'todo') return 'tasks';
    return 'alarm';
  }

  function snoozeMinutes() {
    const value = Number(State.settings().notifications.snoozeMinutes);
    return Number.isFinite(value) && value > 0 ? value : 10;
  }

  function handleReminder(reminder) {
    if (!reminder) return;
    // The click handler on an OS toast reuses this channel just to raise the
    // window; it is not a second alarm.
    if (reminder.action === 'click') {
      focusReminder(reminder);
      return;
    }

    const settings = State.settings().notifications;
    if (settings.sound && !settings.silent) UI.chime(reminder.kind === 'todo' ? 'alert' : 'chime');

    const actions = [
      {
        label: `Snooze ${snoozeMinutes()}m`,
        onClick: () => {
          hrdock.reminders.snooze(reminder, snoozeMinutes());
          UI.toast({ title: `Snoozed for ${snoozeMinutes()} minutes`, timeout: 1800 });
        }
      },
      {
        label: 'Open',
        primary: true,
        onClick: () => focusReminder(reminder)
      }
    ];

    if (reminder.kind === 'todo') {
      actions.unshift({
        label: 'Done',
        onClick: () => {
          const todo = State.Todos.byId(reminder.refId);
          if (todo && !todo.done) State.Todos.toggle(todo.id);
          hrdock.reminders.dismiss(reminder.key);
        }
      });
    }

    UI.toast({
      kind: 'reminder',
      icon: iconFor(reminder.kind),
      title: reminder.title,
      message: reminder.body,
      actions,
      timeout: 0                 // reminders wait for a decision
    });
  }

  /** Bring the relevant view forward for the thing that just fired. */
  function focusReminder(reminder) {
    hrdock.window.command('show');
    if (State.settings().compact) hrdock.window.command('compact', false);

    if (reminder.kind === 'todo') {
      App.setTab('tasks');
      const todo = State.Todos.byId(reminder.refId);
      if (todo) Tasks.openEditor(todo);
    } else {
      App.setTab('calendar');
      if (reminder.day) Calendar.select(reminder.day);
    }
  }

  function init() {
    hrdock.on('reminder:fired', handleReminder);
  }

  global.Notify = { init, handleReminder };
}(window));
