-- =============================================================================
-- Tourniquet · 90 · Semilla de catalogo
-- MOTOR: SQL Server
--
-- QUE ES ESTE SCRIPT
--   Carga el catalogo MINIMO de una instalacion: apps, clientes, el vinculo
--   cliente-aplicacion y el INVENTARIO de bases de negocio. Idempotente: se puede
--   correr las veces que haga falta, sin duplicar ni pisar lo que ya esta.
--
--   Los datos NO estan escritos como una cadena de INSERT repetidos, sino en una
--   tabla de entrada (#catalogo) que se recorre con un cursor. Agregar un cliente
--   o una base es agregar UNA fila a esa tabla, no copiar un bloque de 12 lineas.
--
--
-- QUE SE SIEMBRA, Y QUE NO, Y POR QUE
--   NO lleva usuarios.  El primer administrador lo crea
--     `scripts/bootstrap-admin.mjs` (hash argon2id, clave por prompt).
--     Una clave en un `.sql` es una credencial en el repo, y `.gitignore` no
--     protege un archivo ya commiteado.
--   NO lleva contrasenas de bases.  `credencial_cifrada` va NULL. Las carga
--     `scripts/registrar-base.mjs`, que cifra con AES-256-GCM antes de escribir
--     (`specs/01` §6). Un `.sql` con la clave de una base de negocio en claro
--     seria una credencial de produccion versionada.
--   NO lleva claves de firma.  Las genera
--     `scripts/generar-clave.mjs` / `bootstrap-admin.mjs`; la master key vive
--     en el entorno, nunca en la base ni en un backup suelto.
--
--
-- EL CLIENTE `sin_registrar` ES UN CENTINELA, NO UN NOMBRE
--   `cat_base_datos.usuario` es NOT NULL a proposito: la base existe, y lo que
--   no se conoce todavia es el login con el que se le habla. En vez deNullable,
--   se usa el centinela N'sin_registrar'.
--   ---> REGLA PARA EL CODIGO: NUNCA pasar `usuario` a una conexion sin antes
--        comparar contra N'sin_registrar'. Un string de conexion armado con ese
--        valor no es un error visible: es un login que no existe, y el mensaje
--        que devuelve el motor no dice "no lo registraste", dice "login failed".
--   La columna `credencial_cifrada` en cambio SI es NULL de verdad, y el
--   inventario lo distingue por el dato (ver seccion 5).
--
--
-- IMPORTANTE - ESTA SEMILLA ES PARA DESARROLLO
--   Los `redirect_uri` de la app `rhpro` de abajo son de `localhost`. En una
--   instalacion de cliente NO se usa este archivo: se genera uno propio con
--   `scripts/generar-instalacion.mjs`, que escribe los dominios reales.
--   Un `localhost` que queda en `cat_aplicacion.redirect_uris_json` de una
--   instalacion real es un redirect_uri valido para siempre: alguien que corra un
--   IdP en su maquina podria canjear codes. Ver Fase 10, trampa 5.
--
--
-- DEPLOY (BACK Y FRONT)
--   Que la app de un cliente este aca o en otro servidor NO se registra en la
--   base de control (D7 de `specs/00-arquitectura.md` §4.1): Tourniquet es un
--   mecanismo de logueo y no abre conexiones a bases ajenas. `host` dice donde
--   vive LA BASE, que es un dato distinto y si importa. La columna `notas` de
--   esta semilla anota a mano donde corre la app, porque es util al desplegar,
--   pero NADIE debe filtrar por ella: no es una columna consultable por codigo.
--
--
-- QUEIENE LO EJECUTA
--   El agente, sobre `tourniquet_dev` unicamente, con `scripts/ejecutar-sql-dev.mjs`
--   (guardia dura de `AGENTS.md` regla 3). El SQL de produccion lo corre el
--   usuario, sobre la semilla que el le genero.
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- 90 · Semilla de catalogo (desarrollo)';
PRINT N'-- apps + clientes + vinculos + inventario de bases.';
PRINT N'-- Sin usuarios, sin contrasenas, sin claves.';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- 1 · Los datos de entrada
--
-- Una sola tabla con todo lo que se siembra. Es lo que hace que este script no
-- crezca: el dia que entre un quinto cliente, se agrega una fila y nada mas.
--
-- Los 4 clientes del despliegue actual:
--   cervi / marcelino   -> su app corre en ESTE servidor
--   jugos  / santander  -> su app corre enteramente en otro lado (D7)
--
-- Las 4 bases son de RHPro, pero el esquema no lo exige: `idaplicacion` es una
-- FK a `cat_aplicacion`, no un literal. El dia que entre una app que no sea
-- RHPro, se agrega la fila en #apps y se la referencia desde #bases.
-- -----------------------------------------------------------------------------
-- Cada temporal lleva su DROP pegado al CREATE. Si el script se corta a mitad
-- de camino y se vuelve a correr, el `DROP` esta a la vista en el mismo bloque
-- en vez de al principio del archivo, donde ya no se sabe que existe.
IF OBJECT_ID(N'tempdb..#apps') IS NOT NULL DROP TABLE #apps;
CREATE TABLE #apps
(
    fila             int IDENTITY(1,1) NOT NULL,
    codigo           nvarchar(40)  NOT NULL,
    nombre           nvarchar(100) NOT NULL,
    tipo_cliente     nvarchar(10)  NOT NULL,
    redirect_uris    nvarchar(max) NOT NULL,
    origenes         nvarchar(max) NOT NULL,
    -- Donde abre el lanzador del portal (Fase 07). Es la pagina que inicia el
    -- flujo OIDC de la app: su state y su challenge (`specs/01` §1.2).
    url_inicio       nvarchar(1000) NOT NULL
);

IF OBJECT_ID(N'tempdb..#clientes') IS NOT NULL DROP TABLE #clientes;
CREATE TABLE #clientes
(
    fila             int IDENTITY(1,1) NOT NULL,
    codigo           nvarchar(20)  NOT NULL,
    nombre           nvarchar(100) NOT NULL
);

IF OBJECT_ID(N'tempdb..#bases') IS NOT NULL DROP TABLE #bases;
CREATE TABLE #bases
(
    fila             int IDENTITY(1,1) NOT NULL,
    codigo           nvarchar(40)  NOT NULL,
    idcliente        nvarchar(20)  NOT NULL,
    idaplicacion     nvarchar(40)  NOT NULL,
    host             nvarchar(200) NOT NULL,
    [base]           nvarchar(100) NOT NULL,
    usuario          nvarchar(100) NOT NULL,
    estado           nvarchar(10)  NOT NULL,
    notas            nvarchar(500) NULL
);

-- Apps. `rhpro` es la de hoy. Su codigo es el `aud` que se emite en el token, asi
-- que es estable y legible: cambiarlo invalida todos los tokens emitidos.
--
-- `url_inicio` es `/login` y no `/`: la pagina de ingreso es la que tiene el boton
-- de Tourniquet y la que arma el `state` y el challenge del canje. Con `/` el
-- usuario llegaria al login igual (por un 302 de la app) pero con un salto de mas
-- entre el lanzador y la pantalla de ingreso.
INSERT INTO #apps (codigo, nombre, tipo_cliente, redirect_uris, origenes, url_inicio)
VALUES
    (N'rhpro', N'RHPro', N'public',
     N'["http://localhost:3000/auth/callback"]',
     N'["http://localhost:3000"]',
     N'http://localhost:3000/login');

-- Clientes. `codigo` sale en el claim `tenant` del token: es el identificador de
-- la persona en ESE cliente, asi que no se cambia nunca.
-- Marcelino es el cliente de desarrollo: su base es donde se trabaja RHPro hoy.
-- NO lleva columna de "app en este servidor": ver la cabecera y D7. Donde vive
-- el back y front de cada cliente se anota en `cat_base_datos.notas`.
INSERT INTO #clientes (codigo, nombre)
VALUES
    (N'cervi',     N'RRHH Cervi'),
    (N'marcelino', N'RRHH Marcelino'),
    (N'jugos',     N'RRHH Jugos'),
    (N'santander', N'RRHH Santander');

-- Inventario de bases de negocio. SOLO INVENTARIO: sin contrasena.
-- `usuario` = N'sin_registrar' cuando todavia no se sabe el login (ver la nota
-- del centinela arriba). Cuando se sepa, `scripts/registrar-base.mjs` lo escribe
-- junto con la credencial cifrada.
--
-- OJO con el indice UQ_cat_base_datos_cliente_aplicacion_activa: una base ACTIVA
-- por combinacion cliente+app. Los 4 clientes de aca tienen una base RHPro cada
-- uno, asi que entra. Si un cliente llega a tener DOS bases de la MISMA app
-- activas, el indice lo va a rechazar, y es a proposito (ver mas abajo).
INSERT INTO #bases (codigo, idcliente, idaplicacion, host, [base], usuario, estado, notas)
VALUES
    (N'ARG_RHPro_Cervi',     N'cervi',     N'rhpro', N'localhost', N'rhpro_cervi',
     N'sin_registrar', N'activo', N'app en este servidor'),
    (N'ARG_RHPro_Marcelino', N'marcelino', N'rhpro', N'localhost', N'rhpro_marcelino',
     N'sin_registrar', N'activo', N'app en este servidor'),
    (N'ARG_RHPro_Jugos',     N'jugos',     N'rhpro', N'<host-jugos>', N'rhpro_jugos',
     N'sin_registrar', N'activo', N'app remota; completar host y usuario'),
    (N'CHI_RHPro_Santander', N'santander', N'rhpro', N'<host-santander>', N'rhpro_santander',
     N'sin_registrar', N'activo', N'app remota; completar host y usuario');
PRINT N'-- Datos de entrada: 1 app, 4 clientes, 4 bases';
GO


-- -----------------------------------------------------------------------------
-- 2 · Apps
-- -----------------------------------------------------------------------------
DECLARE @codigo nvarchar(40), @nombre nvarchar(100), @tipo nvarchar(10),
        @uris nvarchar(max), @orig nvarchar(max), @inicio nvarchar(1000);

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT codigo, nombre, tipo_cliente, redirect_uris, origenes, url_inicio FROM #apps;

OPEN cur;
FETCH NEXT FROM cur INTO @codigo, @nombre, @tipo, @uris, @orig, @inicio;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.cat_aplicacion WHERE codigo = @codigo)
    BEGIN
        INSERT INTO dbo.cat_aplicacion
            (codigo, nombre, tipo_cliente, redirect_uris_json, origenes_json, url_inicio, estado)
        VALUES (@codigo, @nombre, @tipo, @uris, @orig, @inicio, N'activo');
        PRINT N'-- Aplicacion [' + @codigo + N']';
    END
    ELSE
    BEGIN
        -- La `url_inicio` SI se actualiza, a diferencia del `nombre` del cliente. La
        -- razon es que esta columna la define la forma de servir la app, y esa se
        -- mueve: si la app pasa de `/login` a otra pagina, o de puerto, el
        -- lanzador tiene que abrir la nueva. Y no la pisa a ciegas: solo si la que
        -- tiene la fila esta vacia, o sea si la app todavia no fue declarada
        -- (es el caso de la base que instalo el `01` y todavia no corrio esta
        -- semilla). Una `url_inicio` escrita por una persona se respeta.
        IF ISNULL((SELECT url_inicio FROM dbo.cat_aplicacion WHERE codigo = @codigo), N'') = N''
        BEGIN
            UPDATE dbo.cat_aplicacion
            SET url_inicio = @inicio
            WHERE codigo = @codigo;
            PRINT N'-- Aplicacion [' + @codigo + N'] ya existe (url_inicio cargada)';
        END
        ELSE
            PRINT N'-- Aplicacion [' + @codigo + N'] ya existe (url_inicio se respeta)';
    END
    FETCH NEXT FROM cur INTO @codigo, @nombre, @tipo, @uris, @orig, @inicio;
END
CLOSE cur;
DEALLOCATE cur;
GO

-- -----------------------------------------------------------------------------
-- 3 · Clientes
-- -----------------------------------------------------------------------------
DECLARE @codigo nvarchar(20), @nombre nvarchar(100);

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT codigo, nombre FROM #clientes;

OPEN cur;
FETCH NEXT FROM cur INTO @codigo, @nombre;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.cat_cliente WHERE codigo = @codigo)
    BEGIN
        INSERT INTO dbo.cat_cliente (codigo, nombre, estado)
        VALUES (@codigo, @nombre, N'activo');
        PRINT N'-- Cliente [' + @codigo + N']';
    END
    ELSE
    BEGIN
        -- Se actualiza el nombre: la semilla es la fuente de la verdad del
        -- catalogo, y un nombre desactualizado se ve raro en el portal. NO se
        -- tocan las apps del cliente ni su estado: eso decidio una persona.
        --
        -- OJO ANTES DE USAR ESTO EN UNA INSTALACION REAL (Fase 04, anotado el
        -- 2026-09-29): este UPDATE pisa el `nombre` de un cliente que ya tiene
        -- un nombre real. En `tourniquet_dev` se noto cuando los clientes se
        -- renombraron a sus nombres de verdad (RRHH Cervi, RRHH Santander
        -- Chile, ...) y un `npm run sql:dev` de rutina los devolvio a
        -- "RRHH Cervi". Decision conscious del 2026-09-29: la semilla
        -- sigue siendo la fuente de la verdad del catalogo, y el nombre real
        -- se carga por SQL propio cuando se esta instalando un cliente.
        -- Si alguna vez molesta, el arreglo es SACAR este UPDATE (y con el el
        -- `nombre` pasa a ser dato de una persona, igual que `estado` y las
        -- apps) y no agregar una bandera: dos fuentes de verdad para la misma
        -- columna es peor que una sola.
        UPDATE dbo.cat_cliente
        SET nombre = @nombre
        WHERE codigo = @codigo;
        PRINT N'-- Cliente [' + @codigo + N'] ya existe (nombre actualizado)';
    END
    FETCH NEXT FROM cur INTO @codigo, @nombre;
END
CLOSE cur;
DEALLOCATE cur;
GO

-- -----------------------------------------------------------------------------
-- 4 · Vinculo cliente-aplicacion
--
-- Que apps existen PARA este cliente. Sin esta fila, el authorize de la app
-- responde unauthorized_client aunque la app y el cliente esten activos.
-- -----------------------------------------------------------------------------
DECLARE @codigo nvarchar(40), @idcliente nvarchar(20);

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT DISTINCT idcliente, idaplicacion FROM #bases ORDER BY idcliente, idaplicacion;

OPEN cur;
FETCH NEXT FROM cur INTO @idcliente, @codigo;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.cat_cliente_aplicacion
                   WHERE idcliente = @idcliente AND idaplicacion = @codigo)
    BEGIN
        INSERT INTO dbo.cat_cliente_aplicacion (idcliente, idaplicacion)
        VALUES (@idcliente, @codigo);
        PRINT N'-- Vinculo [' + @idcliente + N'] -> [' + @codigo + N']';
    END
    ELSE
        PRINT N'-- Vinculo [' + @idcliente + N'] -> [' + @codigo + N'] ya existe';
    FETCH NEXT FROM cur INTO @idcliente, @codigo;
END
CLOSE cur;
DEALLOCATE cur;
GO

-- -----------------------------------------------------------------------------
-- 5 · Inventario de bases de negocio - SIN CONTRASENA
--
-- Lo que se escribe aca es INVENTARIO, no una credencial:
--   - `credencial_cifrada` queda NULL. Se carga con `scripts/registrar-base.mjs`,
--     que cifra con AES-256-GCM (iv(12)|tag(16)|ciphertext).
--   - `usuario` va con el centinela N'sin_registrar' si todavia no se conoce.
--
-- Por que NO se cifra aca: no se puede escribir un valor cifrado en un `.sql` de
-- forma util, porque el IV es aleatorio POR REGISTRO y se genera en el momento
-- del cifrado (`specs/01` §6). Un IV fijo reutilizado con GCM rompe la
-- confidencialidad por completo.
--
-- OJO - EL LIMITE DE UNA BASE ACTIVA POR CLIENTE+APP
--   UQ_cat_base_datos_cliente_aplicacion_activa es UNICO y FILTRADO por
--   estado='activo'. O sea: una sola base activa por combinacion cliente+app.
--   Los 4 clientes de esta semilla entran bien. Pero si un cliente llega a tener
--   dos bases de la misma app ACTIVAS (por ejemplo, una en ARG y otra en CHI),
--   el indice las rechaza con "Cannot insert duplicate key".
--   Cuando eso pase NO se resuelve poniendo la segunda en inactivo por el
--   margen: la segunda base es real y esta activa. La pregunta a responder antes
--   es si el indice tiene que cambiar a (idcliente, idaplicacion, codigo), y esa
--   es una decision de schema, con su incremental y su spec.
-- -----------------------------------------------------------------------------
DECLARE @cod nvarchar(40), @cli nvarchar(20), @app nvarchar(40),
        @host nvarchar(200), @base nvarchar(100), @usr nvarchar(100),
        @estado nvarchar(10), @notas nvarchar(500);

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT codigo, idcliente, idaplicacion, host, [base], usuario, estado, notas
    FROM #bases ORDER BY codigo;

OPEN cur;
FETCH NEXT FROM cur INTO @cod, @cli, @app, @host, @base, @usr, @estado, @notas;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.cat_base_datos WHERE codigo = @cod)
    BEGIN
        INSERT INTO dbo.cat_base_datos
            (codigo, idcliente, idaplicacion, host, [base], usuario,
             credencial_cifrada, [engine], estado, notas)
        VALUES
            (@cod, @cli, @app, @host, @base, @usr,
             NULL,                        -- credencial_cifrada
             N'sqlserver', @estado, @notas);
        PRINT N'-- Base [' + @cod + N'] (inventario, SIN contrasena)';
    END
    ELSE
        PRINT N'-- Base [' + @cod + N'] ya existe';
    FETCH NEXT FROM cur INTO @cod, @cli, @app, @host, @base, @usr, @estado, @notas;
END
CLOSE cur;
DEALLOCATE cur;
GO


-- =============================================================================
-- 6 · Verificacion
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · 90-semilla-catalogo ---';
PRINT N'';

PRINT N'--- 1 · Apps ---';
SELECT codigo, nombre, tipo_cliente, url_inicio, estado FROM dbo.cat_aplicacion ORDER BY codigo;
GO

PRINT N'--- 2 · Clientes ---';
SELECT codigo, nombre, estado FROM dbo.cat_cliente ORDER BY codigo;
GO

PRINT N'--- 3 · Vinculos cliente-aplicacion ---';
SELECT idcliente, idaplicacion
FROM dbo.cat_cliente_aplicacion
ORDER BY idcliente, idaplicacion;
GO

PRINT N'--- 4 · Inventario de bases (esperadas: 4) ---';
PRINT N'-- usuario = sin_registrar y credencial = SIN CREDENCIAL es lo correcto aca:';
PRINT N'-- la base esta registrada, pero todavia no se le habla a ningun lado.';

SELECT
    codigo, idcliente, idaplicacion, host, [base],
    -- Se muestra SI/NO en vez del valor: la longitud del binario ya dice si hay
    -- material cifrado, y asi el inventario es seguro de mostrar o exportar.
    CASE WHEN credencial_cifrada IS NULL
         THEN N'SIN CREDENCIAL'
         ELSE N'CIFRADA (' + CAST(DATALENGTH(credencial_cifrada) AS nvarchar(10)) + N' B)'
    END AS credencial,
    -- El centinela se marca explicitamente para que no se lea como un login.
    CASE WHEN usuario = N'sin_registrar'
         THEN N'sin_registrar (PENDIENTE)'
         ELSE usuario
    END AS usuario,
    [engine], estado, notas
FROM dbo.cat_base_datos
ORDER BY codigo;
GO

PRINT N'--- 5 · Conteos de seguridad (todo en 0 es lo correcto) ---';
SELECT
    (SELECT COUNT(*) FROM dbo.idn_usuario)                  AS usuarios,
    -- Con usuarios cargados, la clave de firma tiene que existir: sin ella el
    -- JWKS responde vacio y ninguna app puede validar tokens.
    (SELECT COUNT(*) FROM dbo.tok_clave_firma
        WHERE activa = 1)                                   AS claves_activas,
    -- El hash SIEMPRE empieza con $argon2id$. Un valor que no, es una clave en
    -- claro o un hash de otro algoritmo: hay que revisarlo antes de seguir.
    (SELECT COUNT(*) FROM dbo.idn_usuario
        WHERE clave_hash NOT LIKE '$argon2id$%')           AS hashes_no_argon2id,
    -- Con datos cargados y cero claves de firma, algo se cargo por SQL en vez
    -- de por script.
    (SELECT CASE WHEN (SELECT COUNT(*) FROM dbo.idn_usuario) > 0
                  AND (SELECT COUNT(*) FROM dbo.tok_clave_firma) = 0
                 THEN 1 ELSE 0 END)                         AS usuarios_sin_clave_firma,
    -- Una base con credencial pero sin usuario, o al reves, es un registro a
    -- medio hacer: no sirve ni para diagnosticar ni para conectar.
    (SELECT COUNT(*) FROM dbo.cat_base_datos
        WHERE (credencial_cifrada IS NULL AND usuario <> N'sin_registrar')
           OR (credencial_cifrada IS NOT NULL AND usuario = N'sin_registrar'))
                                                           AS registros_a_medias;
GO

PRINT N'';
PRINT N'-- 90-semilla-catalogo aplicado.';
PRINT N'-- Siguiente: scripts/registrar-base.mjs (credenciales) y scripts/bootstrap-admin.mjs';
GO
