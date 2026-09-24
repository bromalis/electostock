-- Category names are unique regardless of letter case ("Resistor" = "resistor"),
-- as they were in the old sheet-based app.
create unique index categories_name_lower_idx on public.categories (lower(name));
