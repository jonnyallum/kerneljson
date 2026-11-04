-- Allow the existing durable inbox to record ordinary text turns. Raw input remains hash-only.
alter table kernel_private.telegram_inbox drop constraint if exists telegram_inbox_command_check;
alter table kernel_private.telegram_inbox add constraint telegram_inbox_command_check
  check (command in ('STATUS','MISSION','TASK','MALFORMED','REMEMBER','MEMORIES','MEMORY','FORGET','CHAT'));
