-- ARCH-18: drop deprecated frames table
-- Frames have been served from in-memory cache only since the MJPEG
-- refactor. The table was empty and the two DELETE statements that
-- referenced it (camera delete/release) were no-ops.
DROP TABLE IF EXISTS frames;
