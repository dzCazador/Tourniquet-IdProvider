-- =============================================================================
-- _reset-dev.sql · DESARROLLO UNICAMENTE · DESTRUCTIVO
--
-- Borra la base de desarrollo COMPLETA (MDF y LDF incluidos) y la deja creada y
-- vacia, para probar el esquema desde cero sin arrastrar corridas anteriores.
--
-- ES T-SQL PURO. No lleva directivas de sqlcmd (`:setvar`, `:r`, `:on error`):
-- corre igual en sqlcmd, en SSMS y en Azure Data Studio, que mandan el archivo
-- entero al motor. Una directiva `:` en un archivo que se abre desde el editor
-- es un error de sintaxis, y por eso la confirmacion se hace editando una
-- variable en vez de pasarla por linea de comandos.
--
--
-- POR QUE NO ESTE BORRADO ESTA DENTRO DE `00-crear-base.sql`
--   `00-crear-base.sql` es el camino de INSTALACION y se corre en produccion
--   (Fase 10). Si llevara un DROP al principio, el dia que alguien lo corra
--   contra `tourniquet` --el IdP de un cliente, con sus usuarios y sus apps--
--   borra el IdP entero. Un script de creacion que puede borrar la base que
--   esta por crear no es un script de creacion.
--
--   Por eso el DROP vive aqui: archivo con `_` inicial (el runner lo salta),
--   con la palabra DESTRUCTIVO en el titulo, y con una guarda que aborta.
--
--
-- POR QUE ES UN SOLO LOTE, SIN `GO`
--   Las variables de T-SQL mueren en cada `GO`. Un script partido en lotes solo
--   puede pasar el nombre de la base de un lote al siguiente redefiniendolo en
--   todos, y eso obliga a editar el mismo valor en cuatro lugares distintos: en
--   cuanto uno queda viejo, el script borra una base y reporta otra. Ademas,
--   `CREATE DATABASE` y `DROP DATABASE` se ejecutan fuera de transaccion de
--   usuario, y un unico lote es la forma simple de garantizarlo.
--
--   El costo es que no se puede ver el resultado paso a paso en el editor: se ve
--   al terminar. Para un script que hace una sola cosa, es un costo aceptable.
--
--
-- COMO SE USA
--   1. Abrir este archivo y editar las dos lineas de la seccion 1:
--          @confirmar  ->   N'BORRAR'
--          @base       ->   la base que quieras borrar y recrear
--   2. Correr el archivo entero.
--   3. Volver a dejar @confirmar en N'' , para que el script no pueda dispararse
--      por accidente otra vez.
--
--   El paso 3 no es opcional: es lo que separa "borrar la base de desarrollo"
--   de "borrar cualquier base". Con @confirmar vacio el script no hace nada.
--
--   Ojo: hay que correrlo desde una base que NO sea la que se va a borrar.
--   Con SSMS o ADS, abrir una consulta nueva: se conecta a la que toque y el
--   DROP falla. Con sqlcmd, apuntar a master:
--       sqlcmd -S <srv> -U <usr> -P <pwd> -d master -b -i deploy/sql/_reset-dev.sql
--
--
-- QUE HACE, EN ORDEN
--   1. Aborta si @confirmar <> 'BORRAR', si @base quedo vacia, si @base es una
--      base del sistema, o si @base es la base a la que esta conectada la
--      sesion (el DROP fallaria).
--   2. Muestra en grande que base va a borrar y por que, con servidor y usuario.
--   3. Cierra conexiones abiertas (SINGLE_USER WITH ROLLBACK IMMEDIATE) para
--      que el Management Studio, un job o la app de desarrollo no lo traben.
--   4. DROP DATABASE. Esto borra tambien los .mdf y .ldf: no hay que borrarlos
--      a mano. Ver "ARCHIVOS MDF/LDF" al final.
--   5. CREATE DATABASE con un collation explicito.
--   6. Imprime el comando siguiente. NO aplica el esquema: eso se hace aparte.
--
--
-- POR QUE NO APLICA EL ESQUEMA AL FINAL
--   `00-crear-base.sql` abre `[tourniquet]` en su bloque 0. Si este script lo
--   aplicara sobre una base que no sea `tourniquet`, la sesion saltaria a
--   `tourniquet` y el esquema se escribiria ahi: sobre produccion, desde un
--   script de desarrollo. Por eso este script se detiene y te dice que correr.
--
--
-- QUEIENE LO CORRE
--   El USUARIO. El agente no lo ejecuta (AGENTS.md regla 3): borrar una base es
--   DDL destructivo y lo decides vos, no yo.
-- =============================================================================


-- =============================================================================
-- 1 · EDITAR ESTAS DOS LINEAS Y NADA MAS
-- =============================================================================
DECLARE @confirmar NVARCHAR(64) = N'';                       -- <== poner N'BORRAR' para ejecutar
DECLARE @base      NVARCHAR(128) = N'tourniquet_dev';        -- base a borrar y recrear
-- =============================================================================

SET NOCOUNT ON;

DECLARE @sql     NVARCHAR(400) = N'';
DECLARE @base_id NVARCHAR(128) = N'';

SET @base_id = LTRIM(RTRIM(@base));


-- -----------------------------------------------------------------------------
-- 2 · GUARDIAS. Todas antes de tocar nada: si alguna falla, no se borro nada.
-- -----------------------------------------------------------------------------
IF @confirmar IS NULL OR @confirmar <> N'BORRAR'
BEGIN
    PRINT N'';
    PRINT N'ABORTO: falta la confirmacion. No se borro nada.';
    PRINT N'';
    PRINT N'Para ejecutar este script, edita la seccion 1 de arriba y ponla asi:';
    PRINT N'';
    PRINT N'    DECLARE @confirmar NVARCHAR(64) = N''BORRAR'';';
    PRINT N'';
    PRINT N'Y despues, acordate de volverla a N''''';
    THROW 50010, 'Falta la confirmacion: @confirmar debe ser N''BORRAR''. No se borro nada.', 1;
END

IF @base_id = N''
BEGIN
    THROW 50011, 'ABORTO: @base quedo vacio. Ponerla asi: DECLARE @base NVARCHAR(128) = N''tourniquet_dev'';', 1;
END

-- Bases del sistema: ni por error.
IF @base_id IN (N'master', N'model', N'msdb', N'tempdb')
BEGIN
    THROW 50012, 'ABORTO: no se toca una base del sistema.', 1;
END

-- Si la sesion esta conectada a la base que se quiere borrar, el DROP falla
-- con "cannot drop the database because it is currently in use". Es mejor
-- detectarlo aca que dejar que reviente en el medio, con el ALTER ya hecho.
IF DB_NAME() = @base_id
BEGIN
    THROW 50013, 'ABORTO: la sesion esta conectada justamente a la base que se quiere borrar. Conectate a master y volve a correr.', 1;
END


-- -----------------------------------------------------------------------------
-- 3 · Que base es, en grande. Que quede en el log para siempre.
-- -----------------------------------------------------------------------------
PRINT N'';
PRINT N'============================================================';
PRINT N'  SE VA A BORRAR LA BASE:  ' + UPPER(@base_id);
PRINT N'============================================================';
PRINT N'  Solo desarrollo. Si esto es un servidor con datos reales,';
PRINT N'  para aca. Un DROP DATABASE no se deshace.';
PRINT N'';
PRINT N'  Edicion  : ' + CAST(SERVERPROPERTY(N'Edition')  AS NVARCHAR(100));
PRINT N'  Servidor : ' + CAST(SERVERPROPERTY(N'ServerName') AS NVARCHAR(100));
PRINT N'  Host     : ' + CAST(HOST_NAME()      AS NVARCHAR(100));
PRINT N'  Usuario  : ' + CAST(SUSER_NAME()     AS NVARCHAR(100));
PRINT N'  Ahora    : ' + CAST(SYSDATETIME()    AS NVARCHAR(33));
PRINT N'============================================================';
PRINT N'';


-- -----------------------------------------------------------------------------
-- 4 · Borrar. Va por sp_executesql porque el nombre de la base no puede
--     concatenarse en una sentencia: seria inyeccion de SQL con un archivo que
--     se ejecuta de un clic. Se arma con QUOTENAME y ya.
-- -----------------------------------------------------------------------------
IF DB_ID(@base_id) IS NOT NULL
BEGIN
    PRINT N'-- Cerrando conexiones abiertas de [' + @base_id + N']...';
    SET @sql = N'ALTER DATABASE ' + QUOTENAME(@base_id) + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE;'
             + N' DROP DATABASE ' + QUOTENAME(@base_id) + N';';
    EXEC sp_executesql @sql;
    PRINT N'-- Borrada. Los .mdf y .ldf se fueron con ella.';
END
ELSE
BEGIN
    PRINT N'-- [' + @base_id + N'] no existia. Se crea nueva.';
END


-- -----------------------------------------------------------------------------
-- 5 · Crear. El collation se pide explicitamente: una base de desarrollo con
--     otro collation que produccion hace fallar los JOIN con mensajes que no
--     dicen "collation" y se pierden horas con eso.
--     Si este servidor no tiene el collation, cambialo por uno que exista.
-- -----------------------------------------------------------------------------
IF DB_ID(@base_id) IS NULL
BEGIN
    SET @sql = N'CREATE DATABASE ' + QUOTENAME(@base_id) + N' COLLATE SQL_Latin1_General_CP1_CI_AS;';
    PRINT N'-- Creando [' + @base_id + N']...';
    EXEC sp_executesql @sql;
    PRINT N'-- Creada y vacia.';
END


-- -----------------------------------------------------------------------------
-- 6 · Siguiente paso. Depende de que base se haya borrado: 00 abre
--     [tourniquet] en su bloque 0, y el runner de desarrollo, en cambio, saltea
--     ese bloque y aplica solo el esquema.
-- -----------------------------------------------------------------------------
PRINT N'';
PRINT N'============================================================';
PRINT N'  Base lista y VACIA:  ' + @base_id;
PRINT N'============================================================';
PRINT N'';

IF @base_id = N'tourniquet'
BEGIN
    PRINT N'  Como es [tourniquet], aplica el esquema con el mismo cliente:';
    PRINT N'';
    PRINT N'      deploy/sql/00-crear-base.sql';
    PRINT N'';
    PRINT N'  (00 abre [tourniquet] y aplica todo, incluido su bloque 0.)';
END
ELSE
BEGIN
    PRINT N'  OJO: 00-crear-base.sql abre [tourniquet] en su bloque 0, asi que';
    PRINT N'  NO lo corras crudo contra esta base: te dejaria escribiendo sobre';
    PRINT N'  produccion. Usalo por el runner, que saltea ese bloque:';
    PRINT N'';
    PRINT N'      npm run sql:dev deploy/sql/00-crear-base.sql';
    PRINT N'';
    PRINT N'  El runner es la Fase 01. Mientras tanto, para probar el esquema';
    PRINT N'  contra esta base, aplica el archivo salteando a mano el bloque 0.';
END

PRINT N'';
PRINT N'  Recordar: dejar @confirmar en N''''' de nuevo.';
PRINT N'';
GO


-- =============================================================================
-- ARCHIVOS MDF/LDF
--   DROP DATABASE borra los archivos fisicos: no hay que buscarlos ni borrarlos
--   a mano. Quedan huerfanos solo si un DROP anterior fallo a mitad de camino o
--   si la base fue "detach" sin borrar. En ese caso, desde Git Bash:
--       ls  "/c/Program Files/Microsoft SQL Server/MSSQL"*/DATA/
--       rm  "<base>.mdf" "<base>_log.ldf"
--   Ojo: borra SOLO los de la base de desarrollo. Los de otras bases del mismo
--   servidor no se tocan nunca.
-- =============================================================================
