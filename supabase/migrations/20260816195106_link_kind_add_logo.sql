-- Separate migration: Postgres will not let a new enum value be used in the
-- same transaction that adds it.
alter type link_kind add value if not exists 'logo';;