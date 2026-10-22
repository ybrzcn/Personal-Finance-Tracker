-- v7: devreden bütçe (kategori limitinin artanı/aşanı bu aydan itibaren sonraki aya geçer); YYYY-MM, NULL kapalı

ALTER TABLE budgets ADD COLUMN rollover_from TEXT CHECK (rollover_from IS NULL OR rollover_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
