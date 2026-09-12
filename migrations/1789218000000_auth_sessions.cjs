exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE public.auth_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      access_hash text NOT NULL UNIQUE,
      access_expires_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX auth_sessions_user_id ON public.auth_sessions(user_id);
    CREATE INDEX auth_sessions_expiry ON public.auth_sessions(expires_at);
    CREATE TABLE public.auth_refresh_tokens (
      token_hash text PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES public.auth_sessions(id) ON DELETE CASCADE,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX auth_refresh_tokens_session_id ON public.auth_refresh_tokens(session_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE public.auth_refresh_tokens; DROP TABLE public.auth_sessions;');
};
