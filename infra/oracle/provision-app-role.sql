\set ON_ERROR_STOP on
SELECT format('CREATE ROLE %I LOGIN', :'app_role')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_role')
\gexec
ALTER ROLE :"app_role" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"database_name" TO :"app_role";
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
REVOKE INSERT, UPDATE, DELETE ON public.alembic_version FROM :"app_role";
REVOKE UPDATE, DELETE ON public.audit_events FROM :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
FROM pg_roles WHERE rolname = :'app_role';
