create schema auth;
create function auth.kj_platform_uid() returns uuid language sql stable security definer as $f$ select '00000000-0000-4000-8000-000000000000'::uuid $f$;
create function auth.kj_platform_guard() returns void language plpgsql security definer set search_path = '' as $f$ begin perform 1; end $f$;
create function auth.kj_platform_atomic() returns integer language sql security definer begin atomic select 1; end;
create function auth.kj_platform_len(text) returns integer language internal immutable strict security definer as 'textlen';
revoke execute on function auth.kj_platform_uid() from public;
revoke execute on function auth.kj_platform_guard() from public;
revoke execute on function auth.kj_platform_atomic() from public;
revoke execute on function auth.kj_platform_len(text) from public;
