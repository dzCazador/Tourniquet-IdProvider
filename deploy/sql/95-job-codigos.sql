-- =============================================================================
-- Tourniquet · 95 · Job: limpieza de códigos PKCE y desafíos de MFA
-- MOTOR: SQL Server
--
-- QUE HACE
--   1. `DELETE FROM tok_autorization_code WHERE expira_en < now - 1 dia`.
--   2. `DELETE FROM tok_mfa_challenge   WHERE expira_en < now`.
--
-- POR QUE UN DIA DE GRACIA EN LOS CODES
--   Un authorization code vive 60 segundos (`specs/01` §3). Se borran los que
--   vencieron hace mas de un dia, y no los que acabaron de vencer, por dos razones
--   que no son de rendimiento:
--
--   - Un code vencido TODAVIA se puede canjear durante su minuto de vida, y el
--     error que devuelve es el mismo que el de un code inexistente. Borrar el
--     vencido a los 60 segundos exactos abre una carrera entre el DELETE del job y
--     la peticion de canje, y el sintoma seria un `invalid_grant` en un code que
--     el cliente todavia tenia vivo. Con un dia de margen, la fila esta ahi
--     cuando hace falta.
--   - Un `invalid_grant` hay que poder investigarlo. Si la fila se borro a los 60
--     segundos, "este code se canjeo dos veces" se responde con un error que ya no
--     tiene donde apoyarse.
--
-- POR QUE LOS DESAFIOS DE MFA SE PURGAN ACA Y NO EN UN QUINTO JOB
--   `tok_mfa_challenge` vive 5 minutos y crece con cada login de un usuario con
--   MFA. Es la unica tabla de esta fase que se llena rapido, y el rango de
--   limpieza es el mismo ("vencido"), asi que va en el job de 5 minutos en vez de
--   sumar un `96-` que el operador tiene que lembrar crear. Si alguna vez se
--   separan, es un `NN-job-desafios.sql` nuevo, no reciclar este numero.
--
-- IDEMPOTENCIA
--   Las dos son `DELETE` con filtro de fecha: correrlas dos veces seguidas borra
--   cero la segunda vez y no falla. No hay `INSERT`, ni `UPDATE`, ni estado.
--
-- QUIEN LO EJECUTA
--   El USUARIO, agendado cada 5 minutos:
--     - SQL Agent, si el motor es SQL Server completo; o
--     - Planificador de tareas de Windows + `deploy/jobs/ejecutar-jobs.cmd`, si el
--       motor es **SQL Server Express** (que no tiene Agente).
--   Ver `deploy/runbooks/jobs-limpieza.md`.
--
--   Con `sqlcmd`: `sqlcmd -S <srv> -d tourniquet -b -i 95-job-codigos.sql`
--   (`-b` para que un error de SQL devuelva codigo de salida distinto de 0 y la
--   tarea de Windows la marque como fallida.)
--
-- ROLLBACK
--   No aplica: un `DELETE` de filas vencidas no se deshace. Si se borra de mas, la
--   consecuencia es que un code vencido no se puede canjear (correcto) y que un
--   desafio de MFA se perdio (el usuario tiene que volver a ingresar). Ninguna de
--   las dos es un incidente.
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- 95 · Job: codes PKCE vencidos y desafios de MFA vencidos';
PRINT N'-- Frecuencia: cada 5 minutos';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- 1 · Conteo previo
--
-- Se mide antes y despues en el mismo script, y no solo "cuanto borre": la
-- pregunta que alguien va a hacer cuando el job falle es "que habia y que hay",
-- y con un conteo en cada lado se contesta sin abrir otra sesion.
-- -----------------------------------------------------------------------------
DECLARE @codigosVencidos INT = (
    SELECT COUNT(*) FROM dbo.tok_autorization_code
    WHERE expira_en < DATEADD(day, -1, sysutcdatetime()));

DECLARE @desafiosVencidos INT = (
    SELECT COUNT(*) FROM dbo.tok_mfa_challenge
    WHERE expira_en < sysutcdatetime());

PRINT N'-- Antes: codes vencidos hace mas de 1 dia = ' + CAST(@codigosVencidos AS NVARCHAR(10));
PRINT N'-- Antes: desafios de MFA vencidos             = ' + CAST(@desafiosVencidos AS NVARCHAR(10));
GO


-- -----------------------------------------------------------------------------
-- 2 · Los dos DELETE
--
-- `expira_en` es `datetime2(3)` y `sysutcdatetime()` es `datetime2(7)`: la
-- comparacion es correcta por conversion implicita, y los milisegundos
-- de mas del `now` no cambian que una fila este o no vencida.
--
-- Sin `WHERE` adicional a proposito: el filtro es la fecha y nada mas. Un
-- `DELETE` de esta tabla con un `WHERE` mal escrito borra la tabla entera, y no
-- hace falta ningun otro criterio para saber que filas sobran.
-- -----------------------------------------------------------------------------
DELETE FROM dbo.tok_autorization_code
WHERE expira_en < DATEADD(day, -1, sysutcdatetime());
GO

DELETE FROM dbo.tok_mfa_challenge
WHERE expira_en < sysutcdatetime();
GO


-- =============================================================================
-- 3 · Verificacion
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · 95 · Job de codigos y desafios ---';
PRINT N'';

PRINT N'--- 1 · Conteo posterior (tiene que dar 0 en los dos) ---';
SELECT
    (SELECT COUNT(*) FROM dbo.tok_autorization_code
        WHERE expira_en < DATEADD(day, -1, sysutcdatetime()))  AS codes_vencidos_restantes,
    (SELECT COUNT(*) FROM dbo.tok_mfa_challenge
        WHERE expira_en < sysutcdatetime())                      AS desafios_vencidos_restantes;
GO

PRINT N'--- 2 · Lo que NO se toco (informativo) ---';
PRINT N'-- Los codes y desafios vigentes se conservan: un code de hace 1 hora sigue';
PRINT N'-- en la tabla y un desafio sin usar tambien. Solo se borra lo vencido.';
SELECT
    (SELECT COUNT(*) FROM dbo.tok_autorization_code)            AS codes_totales,
    (SELECT COUNT(*) FROM dbo.tok_mfa_challenge)                AS desafios_totales,
    (SELECT COUNT(*) FROM dbo.tok_autorization_code
        WHERE usado_en IS NULL)                                 AS codes_sin_usar;
GO

PRINT N'-- 95 listo.';
GO
