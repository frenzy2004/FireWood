-- Reducing a legacy radius to the supported ceiling never broadens the
-- monitored area. Invalid low radii remain rejected by the repository boundary.
UPDATE `assets` SET `radius_km` = 100.0 WHERE `radius_km` > 100.0;
--> statement-breakpoint
CREATE TRIGGER `assets_radius_km_insert`
BEFORE INSERT ON `assets`
WHEN typeof(NEW.`radius_km`) NOT IN ('integer', 'real')
  OR NEW.`radius_km` < 1.0
  OR NEW.`radius_km` > 100.0
BEGIN
  SELECT RAISE(ABORT, 'asset radius_km must be between 1 and 100');
END;
--> statement-breakpoint
CREATE TRIGGER `assets_radius_km_update`
BEFORE UPDATE OF `radius_km` ON `assets`
WHEN typeof(NEW.`radius_km`) NOT IN ('integer', 'real')
  OR NEW.`radius_km` < 1.0
  OR NEW.`radius_km` > 100.0
BEGIN
  SELECT RAISE(ABORT, 'asset radius_km must be between 1 and 100');
END;
