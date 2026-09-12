// Identity only. Global roles/capabilities are introduced in step 7.6.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      password_hash text,
      display_name text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT users_email_shape CHECK (
        char_length(email) BETWEEN 3 AND 254
        AND email = btrim(email)
        AND email !~ '[[:space:]]'
        AND email ~ '^[^@]+@[^@]+$'
      ),
      CONSTRAINT users_password_hash_nonempty CHECK (
        password_hash IS NULL OR char_length(btrim(password_hash)) > 0
      ),
      CONSTRAINT users_display_name_length CHECK (
        display_name IS NULL OR (
          char_length(display_name) BETWEEN 1 AND 120
          AND display_name = btrim(display_name)
        )
      )
    );
    CREATE UNIQUE INDEX users_email_unique ON public.users (lower(email));
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE public.users;');
};
