-- Sunlight CLI quota. Reuses the Meteor budget in public.meteor_quotas:
-- same 5 hour window, same 10,000,000 token default, same per-user token_limit override.
--
-- These functions take the user id as an argument and are executable only by
-- service_role, so only the sunlight-chat Edge Function can call them, and only
-- after it has verified the caller's Supabase session.

create or replace function public.sunlight_quota_status(p_user uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  q public.meteor_quotas%rowtype;
  v_now timestamptz := now();
  v_window interval := interval '5 hours';
  v_limit bigint := 10000000;
begin
  select * into q from public.meteor_quotas where user_id = p_user;
  if found and (v_now - q.window_start) < v_window then
    return json_build_object(
      'tokensUsed', q.tokens_used,
      'limit', coalesce(q.token_limit, v_limit),
      'resetsAt', q.window_start + v_window
    );
  end if;
  -- no row, or the window has expired: nothing used yet
  return json_build_object(
    'tokensUsed', 0,
    'limit', coalesce(q.token_limit, v_limit),
    'resetsAt', v_now + v_window
  );
end;
$$;

create or replace function public.sunlight_quota_consume(p_user uuid, p_tokens bigint)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  q public.meteor_quotas%rowtype;
  v_now timestamptz := now();
  v_window interval := interval '5 hours';
  v_limit bigint := 10000000;
  v_used bigint;
  v_start timestamptz;
begin
  if p_user is null then
    raise exception 'user required';
  end if;
  p_tokens := greatest(coalesce(p_tokens, 0), 0);

  select * into q from public.meteor_quotas where user_id = p_user for update;
  if found and (v_now - q.window_start) < v_window then
    update public.meteor_quotas
      set tokens_used = tokens_used + p_tokens, updated_at = v_now
      where user_id = p_user
      returning tokens_used into v_used;
    v_start := q.window_start;
  else
    insert into public.meteor_quotas (user_id, tokens_used, token_limit, window_start, updated_at)
    values (p_user, p_tokens, q.token_limit, v_now, v_now)
    on conflict (user_id) do update
      set tokens_used = excluded.tokens_used,
          window_start = excluded.window_start,
          updated_at = excluded.updated_at
    returning tokens_used into v_used;
    v_start := v_now;
  end if;

  return json_build_object(
    'tokensUsed', v_used,
    'limit', coalesce(q.token_limit, v_limit),
    'resetsAt', v_start + v_window
  );
end;
$$;

-- Functions are executable by PUBLIC by default. Lock them to the server.
revoke all on function public.sunlight_quota_status(uuid) from public, anon, authenticated;
revoke all on function public.sunlight_quota_consume(uuid, bigint) from public, anon, authenticated;
grant execute on function public.sunlight_quota_status(uuid) to service_role;
grant execute on function public.sunlight_quota_consume(uuid, bigint) to service_role;
