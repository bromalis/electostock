-- Stock levels change only through the functions that log them: move_stock()
-- (check in / check out / set, which logs to stock_moves) and checkout() (which
-- logs to checkout_log). Signed-in users keep UPDATE on every other item column.
--
-- Before this, the row-level "edit" policy let any user send
-- PATCH /items {qty: …}: an unlogged, absolute overwrite of whatever changed
-- since they last loaded the page. The page stopped doing that in the previous
-- release (the item form now saves a changed quantity as a logged Set Count).
--
-- New items can still be created with a starting quantity (INSERT is unchanged).

revoke update on public.items from authenticated;
grant update (part, name, category, min, location, unit_cost, supplier, supplier_part, barcode, notes)
  on public.items to authenticated;
