// Establish migration history without introducing product tables (step 7.2).
exports.up = (pgm) => { pgm.sql('SELECT 1;'); };
exports.down = (pgm) => { pgm.sql('SELECT 1;'); };
