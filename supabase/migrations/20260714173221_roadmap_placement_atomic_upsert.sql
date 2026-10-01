-- Make roadmap resource placement (the module→resource edge that pins a quiz /
-- assignment / live session under a module) race-safe.
--
-- writePlacementEdge did DELETE-then-INSERT across two awaits. The table's
-- existing UNIQUE(section_id, from_node_type, from_node_id, to_node_type,
-- to_node_id) does NOT prevent the race: two concurrent placements of the SAME
-- resource under DIFFERENT modules delete each other's edge and both insert,
-- leaving the resource pinned under two modules — breaking the "one placement per
-- resource" contract. We enforce it in the DB instead.

-- 1. Collapse any duplicate module→resource placements a prior race left behind,
--    keeping one arbitrary row per (section_id, to_node_type, to_node_id).
delete from public.roadmap_edges a
using public.roadmap_edges b
where a.from_node_type = 'module'
  and b.from_node_type = 'module'
  and a.section_id = b.section_id
  and a.to_node_type = b.to_node_type
  and a.to_node_id = b.to_node_id
  and a.ctid < b.ctid;

-- 2. One module placement per resource (partial: only module-sourced edges;
--    non-module edges into the same node are unaffected).
create unique index if not exists uq_roadmap_edges_module_placement
  on public.roadmap_edges (section_id, to_node_type, to_node_id)
  where from_node_type = 'module';

-- 3. Atomic idempotent placement — replaces the delete-then-insert. INSERT ...
--    ON CONFLICT DO UPDATE against the partial index: re-placing a resource just
--    moves it (new module + position) in a single statement, no interleaving gap.
--    SECURITY DEFINER + revoked from client roles: only the server admin client
--    (service_role) calls it, and callers still verify auth + ownership first.
create or replace function public.place_roadmap_edge(
  p_section_id uuid,
  p_module_id uuid,
  p_kind text,
  p_resource_id uuid,
  p_position double precision
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.roadmap_edges
    (section_id, from_node_type, from_node_id, to_node_type, to_node_id, edge_type, position)
  values
    (p_section_id, 'module', p_module_id, p_kind, p_resource_id, 'prerequisite', p_position)
  on conflict (section_id, to_node_type, to_node_id) where from_node_type = 'module'
  do update set
    from_node_id = excluded.from_node_id,
    edge_type = excluded.edge_type,
    position = excluded.position;
$$;

revoke execute on function public.place_roadmap_edge(uuid, uuid, text, uuid, double precision) from anon, authenticated;
grant execute on function public.place_roadmap_edge(uuid, uuid, text, uuid, double precision) to service_role;
