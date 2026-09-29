-- =============================================================================
-- Tourniquet · 99 · Verificacion de equivalencia de caminos
-- MOTOR: SQL Server
--
-- QUE HACE
--   Imprime la HUELLA del esquema (columnas, tipos, defaults, nulabilidad,
--   indices, FKs y checks) como un conjunto de filas ordenadas y estables.
--   Esa huella se compara entre dos bases para probar que:
--
--     (A) aplicar SOLO `00-crear-base.sql`
--     (B) aplicar `00-crear-base.sql` + `01-*.sql` + `02-*.sql` + ... en orden
--
--   dejan EXACTAMENTE el mismo esquema. Es la verificacion que hace cumplible
--   la regla de `deploy/README.md`: todo cambio va en un incremental Y en el
--   00-crear-base.sql, y los dos caminos no pueden divergir.
--
-- COMO SE USA
--   1. Crear la base de control con el camino (A) en una base vacia.
--   2. Correr este script sobre esa base y guardar la salida:
--        sqlcmd -S <srv> -d <base_A> -i 99-verificar-esquema.sql -W -s "|" -o huella_A.txt
--   3. Crear otra base vacia y aplicar los incrementales en orden (camino B).
--   4. Correr este script sobre esa base:
--        sqlcmd -S <srv> -d <base_B> -i 99-verificar-esquema.sql -W -s "|" -o huella_B.txt
--   5. Comparar. La unica diferencia admisible es la linea de encabezado, que
--      incluye el nombre de la base:
--        diff <(tail -n +7 huella_A.txt) <(tail -n +7 huella_B.txt)
--   5b. `+7` porque las 6 primeras lineas son encabezado: las 3 primeras cambian
--       en cada corrida (base y timestamp) y no son parte de la huella. Comparar
--       desde la linea 2 daria siempre una diferencia y haria creer que los
--       caminos divergen cuando no divergen.
--   6. Si hay diferencias: hay un incremental que no se aplico tambien al 00,
--      o un cambio en el 00 que no llego a ningun incremental. Se corrige el
--      que falte y se repite. NO se "arregla" la huella a mano: se corrige el SQL.
--
-- POR QUE NO COMPARA DATOS
--   Este script compara ESQUEMA. Los datos (semillas, usuarios) no se comparan:
--   sus credenciales las genera el usuario en su instalacion, por lo que sus
--   valores son distintos por definicion. Lo que tiene que ser igual es la
--   estructura, y eso es lo que se compara.
--
-- QUIEN LO EJECUTA
--   El USUARIO, sobre una base de desarrollo o una copia. Es de solo lectura:
--   no modifica nada y es seguro correrlo en produccion.
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- HUELLA DE ESQUEMA · Tourniquet';
PRINT N'-- base:' + CAST(DB_NAME() AS nvarchar(128));
PRINT N'-- generado:' + CONVERT(nvarchar(33), sysutcdatetime(), 126);
PRINT N'--';
PRINT N'-- Formato: tipo | objeto | nombre | detalle';
PRINT N'--';

-- -----------------------------------------------------------------------------
-- 1 · Columnas
-- Tipo, longitud, nulabilidad, default y si es identidad. Un cambio de nvarchar
-- a varchar, o de NOT NULL a NULL, aparece acá como diferencia.
-- -----------------------------------------------------------------------------
PRINT N'COLUMNAS';
SELECT
    N'COL'                AS tipo,
    t.name                AS objeto,
    c.name                AS nombre,
    ty.name                                   + N'(' +
        CASE WHEN ty.name IN (N'nvarchar', N'nchar')
             THEN CAST(c.max_length / 2 AS nvarchar(10))
             ELSE CAST(c.max_length AS nvarchar(10)) END + N')' +
        CASE WHEN c.is_nullable = 1 THEN N' NULL' ELSE N' NOT NULL' END +
        CASE WHEN c.is_identity = 1 THEN N' IDENTITY' ELSE N'' END +
        CASE WHEN dc.definition IS NOT NULL
             THEN N' DEFAULT ' + dc.definition ELSE N'' END +
        CASE WHEN c.is_computed = 1 THEN N' COMPUTED' ELSE N'' END
                                     AS detalle
FROM sys.tables t
JOIN sys.columns c  ON c.object_id = t.object_id
JOIN sys.types ty   ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id
                                    AND dc.parent_column_id = c.column_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name LIKE N'cat[_]%'
ORDER BY t.name, c.column_id;
GO

-- -----------------------------------------------------------------------------
-- 2 · Claves primarias y unicas
-- Si un incremental agrega una columna, el UNIQUE puede venir con el o sin el.
-- Esta seccion lo delata.
-- -----------------------------------------------------------------------------
PRINT N'INDICES';
SELECT
    N'IDX'                AS tipo,
    t.name                AS objeto,
    i.name                AS nombre,
    CASE WHEN i.is_primary_key = 1 THEN N'PK' ELSE N'UNIQUE' END +
        CASE WHEN i.has_filter = 1 THEN N' (FILTERED)' ELSE N'' END +
        CASE WHEN i.is_unique = 0 AND i.is_primary_key = 0 THEN N' (NONUNIQUE)' ELSE N'' END +
        N' cols: ' +
        STUFF((SELECT ', ' + COL_NAME(ic.object_id, ic.column_id)
                     + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N'' END
               FROM sys.index_columns ic
               WHERE ic.object_id = i.object_id
                 AND ic.index_column_id = ic.key_ordinal
                 AND ic.is_included_column = 0
               ORDER BY ic.key_ordinal
               FOR XML PATH('')), 1, 2, '') +
        CASE WHEN i.has_filter = 1 THEN N' WHERE ' + i.filter_definition ELSE N'' END
                                     AS detalle
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name LIKE N'cat[_]%'
  AND i.name IS NOT NULL
ORDER BY t.name, i.name;
GO

-- -----------------------------------------------------------------------------
-- 3 · Claves foraneas con su ON DELETE
-- El ON DELETE explicito es la diferencia que mas se olvida en un incremental:
-- la FK aparece y el borrado en cascada se cuela sin querer.
-- -----------------------------------------------------------------------------
PRINT N'FOREIGN_KEYS';
SELECT
    N'FK'                 AS tipo,
    t.name                AS objeto,
    fk.name               AS nombre,
    c.name                                   + N' -> ' +
    OBJECT_NAME(fk.referenced_object_id)    + N'(' +
    COL_NAME(fk.referenced_object_id, fk.referenced_column_id) + N')' +
    N' ON DELETE ' + fk.delete_referential_action_desc +
    N' ON UPDATE ' + fk.update_referential_action_desc
                                     AS detalle
FROM sys.foreign_keys fk
JOIN sys.tables t        ON t.object_id = fk.parent_object_id
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns c        ON c.object_id = fkc.parent_object_id
                          AND c.column_id = fkc.parent_column_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name LIKE N'cat[_]%'
ORDER BY t.name, fk.name;
GO

-- -----------------------------------------------------------------------------
-- 4 · Constraints CHECK
-- El dominio de los enums vive aca. Si un incremental agrega una columna con un
-- CHECK pero el 00 no lo tiene, difieren los CHECKS.
-- -----------------------------------------------------------------------------
PRINT N'CHECKS';
SELECT
    N'CHECK'              AS tipo,
    t.name                AS objeto,
    cc.name               AS nombre,
    REPLACE(REPLACE(cc.definition, N'[', N''), N']', N'') AS detalle
FROM sys.check_constraints cc
JOIN sys.tables t ON t.object_id = cc.parent_object_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name LIKE N'cat[_]%'
ORDER BY t.name, cc.name;
GO

PRINT N'-- FIN DE LA HUELLA';
GO
