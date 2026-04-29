-- Switch alarms.alarm_data from TEXT to native JSON so mysql2 parses
-- it on SELECT. Existing rows are valid JSON because createAlarm()
-- always stringifies before insert
ALTER TABLE alarms MODIFY COLUMN alarm_data JSON NOT NULL;
