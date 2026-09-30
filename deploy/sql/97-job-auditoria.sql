-- =============================================================================
-- Tourniquet · 97 · Job: retencion de auditoria
-- MOTOR: SQL Server
--
-- QUE HACE
--   `DELETE FROM aud_login WHERE ts < DATEADD(year, -2, sysutcdatetime())`.
--
-- POR QUE ESTE ES EL JOB MAS IMPORTANTE DE LOS CUATRO
--   Es el unico que **borra** algo que la app no puede borrar nunca. `aud_login` es
--   append-only (invariante de `AGENTS.md`): ningun endpoint la borra, ningun
--   `DELETE` sale del codigo de negocio, y este script es la unica via por la que
--   la tabla deja de crecer. Por eso el borrado es un `.sql` versionado y agendado
--   por el usuario, y no una tarea interna del backend.
--
-- LA RETENCION ES DE 2 ANIOS "O EL CONTRATO DEL CLIENTE"
--   El numero 2 anios es el default de `specs/01` §7. Si un cliente firma 5 anos,
--   se cambia ESTE ARCHIVO y la linea de `specs/01` §7.1, y nada mas: no se
--   "parametriza" el DELETE con una tabla de configuracion, porque un criterio de
--   retencion que se puede cambiar sin dejar rastro en el repo es un criterio que
--   un dia se cambia por error y nadie lo nota hasta que faltan seis meses de
--   auditoria.
--
-- LA MEDIDA EN EL BORDE
--   El filtro es `< DATEADD(year, -2, ...)` y la consecuencia es que una fila que
--   cumple exactamente 2 anos se conserva. Es deliberado (trampa 5 de la fase 09):
--   `DATEADD` respeta la longitud del mes, asi que el 29 de febrero un
--   `DATEADD(year, -2, ...)` cae en un 28 o 27 de febrero, y con `<=` una fila de
--   ese dia habria sido borrada con un dia de antiguedad de mas. Preferible dejar
--   de mas que borrar de mas: sobran filas, no faltan.
--
-- IDEMPOTENCIA
--   Es un `DELETE` con filtro de fecha: correrlo dos veces borra cero la segunda
--   vez y no falla. Correrlo en cualquier mes del ano borra lo que lleva mas de dos
--   anos, y la cantidad borrada no depende de cuando se corra.
--
-- QUIEN LO EJECUTA
--   El USUARIO, una vez por mes. SQL Agent, o Planificador de tareas +
--   `deploy/jobs/ejecutar-jobs.cmd` si el motor es SQL Server Express.
--   Ver `deploy/runbooks/jobs-limpieza.md`.
--
--   Con `sqlcmd`: `sqlcmd -S <srv> -d tourniquet -b -i 97-job-auditoria.sql`
--
-- ROLLBACK
--   No aplica, y no hay copia: por eso la retencion es de 2 anos y no "lo que
--   sobre". Un backup de la base de control con la retencion ya aplicada no
--   devuelve la auditoria borrada; un backup de antes, si (runbook de backup de la
--   Fase 10).
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- 97 · Job: retencion de aud_login (2 anos)';
PRINT N'-- Frecuencia: mensual';
PRINT N'-- AVISO: borra filas de forma irreversible. Correr con la base de';
PRINT N'--         Produccion respaldada.';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- 1 · Conteo previo, y el limite de retencion que se va a aplicar
--
-- El limite se calcula una vez y se imprime. Es el numero que hay que mirar antes
-- de dejar correr el job en una base de cliente: si dice 2022-01-01, se van todas
-- las filas de antes de esa fecha, y eso tiene que ser una decision y no una
-- sorpresa.
-- -----------------------------------------------------------------------------
DECLARE @limite DATETIME2(3) = DATEADD(year, -2, sysutcdatetime());
DECLARE @porBorrar INT = (
    SELECT COUNT(*) FROM dbo.aud_login WHERE ts < @limite);

PRINT N'-- Limite de retencion (se borra ts < este valor): '
    + CONVERT(NVARCHAR(33), @limite, 126);
PRINT N'-- Filas a borrar: ' + CAST(@porBorrar AS NVARCHAR(10));
PRINT N'-- (si el numero es 0, el job no tiene nada que hacer: es normal en una';
PRINT N'--  base nueva o en una instalacion con menos de 2 anos de historia)';
GO


-- -----------------------------------------------------------------------------
-- 2 · El DELETE, por lotes
--
-- Por lotes de 5000 y con `TOP` sin orden: borra en transacciones cortas, y el
-- log de transacciones no se llena con una transaccion unica sobre años de
-- auditoria. Es lo unico de este job que NO es trivial, y la razon de que sea
-- por lotes y no un DELETE simple es que `aud_login` es justamente la tabla que
-- mas filas tiene de las cuatro que limpiamos.
--
-- OJO con el `@@ROWCOUNT` (trampa 6 de la fase 09, tropezada al aplicar este
-- script): se copia a una variable **antes** de tocar nada mas, porque cualquier
-- sentencia entre el DELETE y el `IF @@ROWCOUNT` vuelve a ponerlo en cero. Con
-- `SET @total = @total + @@ROWCOUNT` seguido de `IF @@ROWCOUNT = 0 BREAK`, el
-- corte nunca se cumple y el job queda en un `WHILE` infinito borrando cero
-- filas: no rompe nada de la base, pero consume una conexion y un CPU del
-- servidor para siempre, y en una tarea programada eso es un incidente que
-- nadie entiende. El patron correcto es el de tres lineas de abajo.
--
-- El `WHILE` corta cuando el lote no borra nada. Un job que limpiara todo en un
-- lote volveria a arrancar y borraria cero en el siguiente, que es el
-- comportamiento normal de un job idempotente.
-- -----------------------------------------------------------------------------
DECLARE @lote INT = 5000;
DECLARE @filas INT;
DECLARE @total INT = 0;

WHILE 1 = 1
BEGIN
    DELETE TOP (@lote)
    FROM dbo.aud_login
    WHERE ts < DATEADD(year, -2, sysutcdatetime());

    SET @filas = @@ROWCOUNT;
    SET @total = @total + @filas;

    IF @filas = 0
        BREAK;
END

PRINT N'-- Filas borradas: ' + CAST(@total AS NVARCHAR(10));
GO


-- =============================================================================
-- 3 · Verificacion
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · 97 · Job de retencion de auditoria ---';
PRINT N'';

PRINT N'--- 1 · Conteo posterior (tiene que dar 0) ---';
SELECT
    (SELECT COUNT(*) FROM dbo.aud_login
        WHERE ts < DATEADD(year, -2, sysutcdatetime()))          AS filas_fuera_de_retencion;
GO

PRINT N'--- 2 · Lo que se conserva: la ventana de 2 anos completa ---';
PRINT N'-- Si el total de la tabla cae drasticamente, el job esta borrando de mas.';
SELECT
    (SELECT COUNT(*) FROM dbo.aud_login)                          AS auditoria_total,
    (SELECT MIN(ts) FROM dbo.aud_login)                           AS fila_mas_vieja,
    (SELECT MAX(ts) FROM dbo.aud_login)                           AS fila_mas_nueva,
    (SELECT COUNT(DISTINCT resultado) FROM dbo.aud_login)         AS resultados_distintos;
GO

PRINT N'--- 3 · Append-only: la tabla tiene que seguir con su identity y su FK ---';
SELECT
    c.name                            AS columna,
    ty.name                           AS tipo,
    c.is_identity                     AS identity_,
    CASE WHEN fk.object_id IS NOT NULL THEN N'si' ELSE N'NO' END AS con_fk_a_usuario
FROM sys.columns c
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.foreign_keys fk
       ON fk.parent_object_id = c.object_id
      AND fk.referenced_object_id = OBJECT_ID(N'dbo.idn_usuario')
WHERE c.object_id = OBJECT_ID(N'dbo.aud_login')
  AND c.name IN (N'id', N'idusuario')
ORDER BY c.column_id;
GO

PRINT N'-- 97 listo.';
GO
