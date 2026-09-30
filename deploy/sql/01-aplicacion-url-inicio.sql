-- =============================================================================
-- Tourniquet · 01 · cat_aplicacion.url_inicio
-- MOTOR: SQL Server
--
-- QUE CAMBIA
--   Agrega `url_inicio` a `dbo.cat_aplicacion`: la URL donde el lanzador del portal
--   abre la app (Fase 07). Es la pagina que INICIA el flujo OIDC de la app, no una
--   pagina de presentacion.
--
-- POR QUE
--   La version original de la Fase 07 decia que el portal generaba el `code_verifier`
--   y entraba al `/oidc/authorize` de la app. No es implementable: en PKCE el
--   `code_challenge` lo crea el cliente que va a canjear el `code`, y el `code` vuelve
--   al `redirect_uri` de ESE cliente. El portal no puede canjear por la app (no tiene
--   el verifier) ni pasarle el verifier (seria un secreto en la barra de direcciones,
--   donde queda en el historial y en el `Referer`).
--
--   La consecuencia es que el lanzador tiene que ABRIR la app, y para eso necesita
--   saber cual es su pagina de arranque. Y no la deduce del `redirect_uri`: de
--   `http://app/auth/callback` no sale con certitude `http://app/login`, y cuando
--   no sale, el sintoma es un 404 del web server del cliente que no senala al IdP.
--   Por eso la URL se REGISTRA, igual que el `redirect_uri`. Ver `specs/01` §1.2 y
--   `specs/02` §3.
--
--   No es un control de seguridad: no se valida ni se compara contra nada (no hay
--   redirect abierto, porque el IdP no redirige ahi, el navegador del usuario si).
--   Es un link que el usuario aprieta, y lo declara el cliente de la app.
--
-- AFECTA
--   dbo.cat_aplicacion.url_inicio nvarchar(1000) NOT NULL
--
-- ROLLBACK
--   ALTER TABLE dbo.cat_aplicacion DROP COLUMN url_inicio;
--   (el lanzador deja de tener destino y la Fase 07 no puede funcionar: no es un
--   rollback que tenga sentido en produccion, se documenta por completitud)
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- 01 · cat_aplicacion.url_inicio';
PRINT N'-- La URL de arranque de cada app, registrada y no deducida.';
PRINT N'-- AFECTA: dbo.cat_aplicacion.url_inicio';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- 1 · La columna
--
-- `NULL` primero, `NOT NULL` despues, y en dos lotes.
--
-- El orden NO es estetico: si se agrega NOT NULL con DEFAULT a una tabla con filas,
-- SQL Server lo acepta y pone el default en cada fila existente. Lo que no
-- acepta (y con razon) es NOT NULL sin DEFAULT sobre datos, y como este incremental
-- se aplica a bases que ya tienen apps, el DEFAULT es lo que evita el fallo. La
-- cadena vacia es un valor que NO cumple el significado de la columna: es la marca
-- de "todavia no declarada", y el codigo la trata como "el lanzador no puede
-- arrancar esta app" en vez de abrir una URL vacia.
--
-- La alternativa de ponerla NOT NULL desde el CREATE TABLE de `00-crear-base.sql`
-- es justamente la que hace el camino (A) de `specs/02` §5.1: alla la tabla se
-- crea vacia y el NOT NULL no necesita nada.
-- -----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'dbo.cat_aplicacion')
                 AND name = N'url_inicio')
BEGIN
    ALTER TABLE dbo.cat_aplicacion
        ADD url_inicio nvarchar(1000) NULL
            CONSTRAINT DF_cat_aplicacion_url_inicio DEFAULT N'';

    PRINT N'-- Agregada dbo.cat_aplicacion.url_inicio (NULL, con default vacio)';
END
ELSE
    PRINT N'-- dbo.cat_aplicacion.url_inicio ya existe: no se hace nada';
GO

-- -----------------------------------------------------------------------------
-- 2 · El default deja de existir y la columna pasa a NOT NULL
--
-- Con DEFAULT en su lugar, cualquier INSERT futuro sin `url_inicio` entra con
-- cadena vacia en vez de fallar: el alta de una app nueva pasaria inadvertida y el
-- lanzador mostraria una tarjeta que no abre nada. Se saca el default y se exige
-- el valor explicito.
--
-- Y se hace SOLO si no queda ninguna app sin declarar. Es la parte que hace que este
-- incremental se pueda aplicar en cualquier orden: si la base todavia tiene la app
-- `rhpro` sin `url_inicio` (porque todavia no corrio `90-semilla-catalogo.sql`), la
-- columna se queda nullable con un AVISO y el operador la completa y corre este
-- mismo archivo otra vez. Cuando ya no hay ninguna vacia, se cierra.
--
-- El NO VACIO va primero por una razon que se aprende a la mala: `ALTER COLUMN ...
-- NOT NULL` rellena las filas existentes con el DEFAULT de la columna, y si el
-- default ya se quito, el relleno es NULL y el propio ALTER falla con "no se puede
-- insertar el valor NULL" (Msg 515). Con el default puesto todavia, el ALTER es un
-- no-op de valores y sale limpio.
-- -----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM dbo.cat_aplicacion WHERE ISNULL(url_inicio, N'') = N'')
BEGIN
    PRINT N'-- AVISO: hay apps sin url_inicio. La columna queda nullable y este';
    PRINT N'--       script se vuelve a correr despues de cargarlas (90-semilla';
    PRINT N'--       o el SQL de la instalacion del cliente):';
    SELECT codigo, nombre, N'(sin url_inicio)' AS url_inicio
    FROM dbo.cat_aplicacion
    WHERE ISNULL(url_inicio, N'') = N''
    ORDER BY codigo;
END
ELSE
BEGIN
    IF EXISTS (SELECT 1 FROM sys.default_constraints
               WHERE name = N'DF_cat_aplicacion_url_inicio')
    BEGIN
        ALTER TABLE dbo.cat_aplicacion DROP CONSTRAINT DF_cat_aplicacion_url_inicio;
        PRINT N'-- Quitado el default de url_inicio (a partir de ahora es obligatorio)';
    END

    ALTER TABLE dbo.cat_aplicacion ALTER COLUMN url_inicio nvarchar(1000) NOT NULL;
    PRINT N'-- dbo.cat_aplicacion.url_inicio ahora es NOT NULL';
END
GO

-- -----------------------------------------------------------------------------
-- 3 · Carga de ejemplo para la app de desarrollo
--
-- Es lo unico que este incremental escribe en datos, y es lo minimo para que la
-- Fase 07 se pueda probar: la app `rhpro` de `90-semilla-catalogo.sql` se sirve en
-- el 3000 y su pagina de ingreso es `/login`, que es la que tiene el boton de
-- Tourniquet. Mismo origen que su `redirect_uri` de desarrollo.
--
-- En una instalacion de cliente NO se corre esto: ahi la carga la hace
-- `scripts/generar-instalacion.mjs` con los dominios reales, y el `IF` de abajo no
-- matchea porque la app ya tiene `url_inicio` y el UPDATE no lo pisa.
-- -----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM dbo.cat_aplicacion WHERE codigo = N'rhpro')
   AND (SELECT ISNULL(url_inicio, N'') FROM dbo.cat_aplicacion WHERE codigo = N'rhpro') = N''
BEGIN
    UPDATE dbo.cat_aplicacion
    SET url_inicio = N'http://localhost:3000/login'
    WHERE codigo = N'rhpro';

    PRINT N'-- [dev] cat_aplicacion[rhpro].url_inicio = http://localhost:3000/login';
END
ELSE
    PRINT N'-- cat_aplicacion[rhpro] no existe o ya tiene url_inicio: no se toca';
GO


-- =============================================================================
-- 4 · Verificacion
--
-- Lo que tiene que verse: la columna existe, es NOT NULL, sin default, y toda app
-- tiene una URL de arranque.
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · 01 · cat_aplicacion.url_inicio ---';
PRINT N'';

PRINT N'--- 1 · La columna ---';
SELECT
    c.name                                                        AS columna,
    ty.name + N'(' + CAST(c.max_length / 2 AS nvarchar(10)) + N')' AS tipo,
    CASE WHEN c.is_nullable = 0 THEN N'NOT NULL' ELSE N'NULL' END AS nulabilidad,
    CASE WHEN dc.definition IS NULL THEN N'sin default'
         ELSE N'CON DEFAULT: ' + dc.definition END                 AS default_
FROM sys.columns c
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id
                                   AND dc.parent_column_id = c.column_id
WHERE c.object_id = OBJECT_ID(N'dbo.cat_aplicacion')
  AND c.name = N'url_inicio';
GO

PRINT N'--- 2 · Apps y su url_inicio (una fila por app) ---';
SELECT codigo, nombre, url_inicio, estado
FROM dbo.cat_aplicacion
ORDER BY codigo;
GO

PRINT N'--- 3 · Lo que tiene que dar 0 al final ---';
SELECT
    -- Una app sin url_inicio es una app que el lanzador no puede abrir. Con el
    -- NOT NULL puesto no puede haber, pero se verifica igual: la consulta es la
    -- que alguien va a correr cuando algo "no abre" y tiene que poder contestar.
    (SELECT COUNT(*) FROM dbo.cat_aplicacion
        WHERE ISNULL(url_inicio, N'') = N'')                      AS apps_sin_url_inicio,
    -- Una url_inicio que no es http(s) no es una pagina: es un dato mal cargado.
    (SELECT COUNT(*) FROM dbo.cat_aplicacion
        WHERE url_inicio IS NOT NULL
          AND url_inicio NOT LIKE N'http://%'
          AND url_inicio NOT LIKE N'https://%')                   AS urls_no_http;
GO

PRINT N'';
PRINT N'-- 01 aplicado.';
PRINT N'-- Siguiente: 99-verificar-esquema.sql, para comprobar que el camino';
PRINT N'-- incremental deja el mismo esquema que 00-crear-base.sql.';
GO
