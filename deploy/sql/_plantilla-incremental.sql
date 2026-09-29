-- =============================================================================
-- Tourniquet · NN · PLANTILLA de script incremental
-- MOTOR: SQL Server
--
-- ESTA PLANTILLA NO SE EJECUTA. Se copia y se renombra.
-- No se versiona como parte del historial de cambios: es la guia de como
-- escribir un `NN-<cambio>.sql`. El primer incremental real es el que
-- aparezca en el historial de este repo.
--
-- ---------------------------------------------------------------------------
-- QUE ES UN INCREMENTAL
--   Un `.sql` que aplica UN cambio de esquema sobre una base YA EXISTE.
--   Vive junto a `00-crear-base.sql` y ambos tienen que quedar en el mismo
--   commit. Ver `deploy/README.md` para la regla completa.
--
-- NUMERACION
--   El numero va en el nombre y define el ORDEN de aplicacion:
--     01- 02- 03- ...   cambios de esquema
--     90-               semillas de catalogo
--     95- 96- 97- 98-  jobs de limpieza / retencion
--     99-               verificacion
--   Al agregar un cambio nuevo se usa SIEMPRE el siguiente numero libre.
--   Un numero retirado NO se reutiliza: una base que aplico el 07 no puede
--   recibir despues un 07 distinto.
--
-- REGLAS DE ESCRITURA
--   - Idempotente: se puede correr dos veces sin romper nada. Se comprueba con
--     `IF NOT EXISTS (...)` sobre sys.objects / sys.indexes, no sobre la tabla.
--   - `SET NOCOUNT ON;` al principio.
--   - Un lote por `GO`. No `CREATE DATABASE`.
--   - Comentario de proposito arriba: QUE cambia y POR QUE (el "por que" es la
--     parte que se pierde en seis meses).
--   - `SELECT` de verificacion al final: que tiene que verse OK.
--   - NO lleva datos sensibles: ni usuarios, ni claves, ni credenciales de
--     bases. Esos van por script (`scripts/`), nunca en un `.sql`.
--   - No lleva variantes `.mysql.sql`: el motor unico del repo es SQL Server
--     (`AGENTS.md` regla 2). Se escribe igual SQL portable para no hipotecar
--     el futuro.
--   - Si el cambio requiere tocar `specs/02-base-de-datos.md`, se actualiza el
--     spec PRIMERO y despues se escribe el SQL.
-- ---------------------------------------------------------------------------


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- <NN> · <TITULO CORTO DEL CAMBIO>';
PRINT N'-- <PROPOSITO EN UNA FRASE>';
PRINT N'--';
PRINT N'-- POR QUE: <la razon del cambio, no la mecanica>';
PRINT N'-- AFECTA: <tabla(s) y columna(s)>';
PRINT N'-- ROLLBACK: <como se deshace, o "no aplica (cambio aditivo)">';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- EJEMPLO 1 · Agregar una columna
-- Se quita lo specifico; esto es la forma, no el contenido.
-- -----------------------------------------------------------------------------
/*
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'dbo.<cat|idn|tok|aud>_<tabla>')
                 AND name = N'<columna>')
BEGIN
    -- Si la tabla tiene filas, agregar con DEFAULT evita el fallo del NOT NULL
    -- sin default sobre datos existentes (SQL Server lo rechaza).
    ALTER TABLE dbo.<cat|idn|tok|aud>_<tabla>
        ADD <columna> <tipo> NULL
            CONSTRAINT DF_<cat|idn|tok|aud>_<tabla>_<columna> DEFAULT <valor_por_defecto> NULL;

    PRINT N'-- Agregada dbo.<cat|idn|tok|aud>_<tabla>.<columna>';
END
ELSE
    PRINT N'-- dbo.<cat|idn|tok|aud>_<tabla>.<columna> ya existe: no se hace nada';
GO
*/

-- -----------------------------------------------------------------------------
-- EJEMPLO 2 · Crear una tabla
-- -----------------------------------------------------------------------------
/*
IF OBJECT_ID(N'dbo.<cat|idn|tok|aud>_<entidad>', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.<cat|idn|tok|aud>_<entidad>
    (
        id        uniqueidentifier NOT NULL,   -- lo genera la app, no newid()
        -- ... columnas ...
        creado_en datetime2(3)     NOT NULL
                   CONSTRAINT DF_<cat|idn|tok|aud>_<entidad>_creado DEFAULT sysutcdatetime(),
        CONSTRAINT PK_<cat|idn|tok|aud>_<entidad> PRIMARY KEY (id)
        -- CONSTRAINT FK_<cat|idn|tok|aud>_<entidad>_...
        --     FOREIGN KEY (...) REFERENCES dbo.<otra> (...)
        --     ON DELETE NO ACTION ON UPDATE NO ACTION
        --     -- NO ACTION en las dos, siempre. En SQL Server NO EXISTE
        --     -- "RESTRICT": no es palabra reservada de este motor y
        --     -- escribarla es un error de sintaxis (Msg 156). El que no hace
        --     -- nada al borrar y al actualizar se escribe "NO ACTION".
        --     -- CASCADE va solo si la fila hija no sobrevive sin la padre
        --     -- (ver las 4 excepciones en `00-crear-base.sql`).
        -- CONSTRAINT CK_<cat|idn|tok|aud>_<entidad>_<campo>
        --     CHECK (<campo> IN (...))
    );
    PRINT N'-- Creada dbo.<cat|idn|tok|aud>_<entidad>';
END
ELSE
    PRINT N'-- dbo.<cat|idn|tok|aud>_<tabla> ya existe: no se hace nada';
GO
*/

-- -----------------------------------------------------------------------------
-- EJEMPLO 3 · Crear un indice
-- -----------------------------------------------------------------------------
/*
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'<IX_o_UQ_nombre>'
                 AND object_id = OBJECT_ID(N'dbo.<cat|idn|tok|aud>_<tabla>'))
BEGIN
    CREATE [UNIQUE] INDEX <IX_o_UQ_nombre> ON dbo.<cat|idn|tok|aud>_<tabla> (<cols>)
        -- WHERE <condicion>     -- indice filtrado: entra en la huella de 99
    PRINT N'-- Indice <IX_o_UQ_nombre>';
END
ELSE
    PRINT N'-- Indice <IX_o_UQ_nombre> ya existe: no se hace nada';
GO
*/


-- =============================================================================
-- Verificacion del incremental
-- Mismo spirit que la de 00: que se vea OK. Si algo no esta OK, el script
-- fallo y hay que revisarlo antes de seguir con el siguiente incremental.
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · <NN> · <TITULO> ---';

SELECT
    N'<objeto>'                                            AS objeto,
    CASE WHEN <existe> = 1 THEN N'OK' ELSE N'FALLA' END    AS estado;
GO

PRINT N'';
PRINT N'-- <NN> aplicado.';
PRINT N'-- Siguiente: 99-verificar-esquema.sql, para comprobar que el camino';
PRINT N'-- incremental deja el mismo esquema que 00-crear-base.sql.';
GO
