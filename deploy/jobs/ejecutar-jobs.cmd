@echo off
REM ============================================================================
REM  Tourniquet - ejecutor de los jobs de limpieza (95- a 98-)
REM
REM  PARA QUE EXISTE
REM    Los jobs de retencion son SQL de TORNiquet (deploy/sql/95-*.sql a
REM    98-*.sql) y los agenda el USUARIO. Esta es la variante para cuando el motor
REM    es SQL Server EXPRESS, que NO tiene SQL Agent: el Planificador de tareas
REM    de Windows corre este archivo cada vez y el archivo corre cada .sql con
REM    sqlcmd.
REM
REM    Si el motor es SQL Server completo, NO usar esto: en SQL Agent se agenda
REM    cada .sql por separado con su propia frecuencia (95 cada 5 minutos, 96
REM    diario, 97 mensual, 98 por hora), que es mejor que un unico paso cada hora
REM    con los cuatro dentro. Ver deploy/runbooks/jobs-limpieza.md.
REM
REM  COMO SE USA (a mano, para probar)
REM    set TQ_JOB_SQL_SERVER=SERVIDOR\INSTANCIA
REM    set TQ_JOB_SQL_BASE=tourniquet
REM    set "PATH=%PATH%;C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn"
REM    deploy\jobs\ejecutar-jobs.cmd
REM
REM    Para correr SOLO uno:
REM    deploy\jobs\ejecutar-jobs.cmd 95
REM
REM  AUTENTICACION
REM    Sin TQ_JOB_SQL_USER, se usa autenticacion integrada de Windows (-E): es la
REM    forma recomendada y la unica que no deja una contrasena escrita en ningun
REM    lado. La cuenta de la tarea tiene que tener un login de SQL con permiso de
REM    escritura SOLO sobre la base de control.
REM
REM    Con TQ_JOB_SQL_USER y TQ_JOB_SQL_PWD se usa autenticacion de SQL Server
REM    (-U/-P). OJO: la contrasena queda en la linea de comandos del proceso
REM    sqlcmd mientras corre, que la puede leer cualquiera con acceso a la lista de
REM    procesos. Si se usa esta variante, la contrasena va en la VARIABLE DE
REM    ENTORNO del paso de la tarea, no como argumento del paso.
REM
REM  CODIGO DE SALIDA
REM    0 = los cuatro jobs Ok. 1 = sqlcmd no esta. 2 = faltan datos de conexion.
REM    3 = un job fallo (sqlcmd -b devuelve distinto de 0 ante un error de SQL).
REM    El Planificador de tareas marca la tarea como fallida con 3, que es lo que
REM    uno quiere ver en el historial.
REM
REM  NOTA DE CODIGO
REM    Este archivo es ASCII a proposito, sin acentos: la consola de Windows
REM    trabaja en una pagina de codigos vieja (437/850) y un .cmd con acentos
REM    muestra caracteres rotos o, peor, corta la linea en el caracter que no se
REM    puede representar. Los comentarios con tildes van en el runbook, que es
REM    UTF-8 y se lee en cualquier editor.
REM ============================================================================

setlocal EnableExtensions

set "SQL_DIR=%~dp0..\sql"
set "LOG_DIR=%ProgramData%\Tourniquet\jobs\log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

REM El primer argumento acota la corrida a UN job (95, 96, 97 u 98), que es lo
REM que se usa para probar uno solo. Vacio = los cuatro.
set "SOLO=%~1"
set "SERVER=%TQ_JOB_SQL_SERVER%"
set "DB=%TQ_JOB_SQL_BASE%"
if "%DB%"=="" set "DB=tourniquet"

REM ---------------------------------------------------------------------------
REM 1 - sqlcmd. Se busca en el PATH y, si no esta, en las rutas donde lo
REM     instala cada version de SQL Server. Buscar en varias es lo que hace que
REM     esto funcione en un servidor con el cliente 160 y en otro con el 150.
REM ---------------------------------------------------------------------------
set "SQLCMD="
where sqlcmd >nul 2>&1 && set "SQLCMD=sqlcmd"
if "%SQLCMD%"=="" if exist "%ProgramFiles%\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\SQLCMD.EXE" set "SQLCMD=%ProgramFiles%\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\SQLCMD.EXE"
if "%SQLCMD%"=="" if exist "%ProgramFiles%\Microsoft SQL Server\Client SDK\ODBC\160\Tools\Binn\SQLCMD.EXE" set "SQLCMD=%ProgramFiles%\Microsoft SQL Server\Client SDK\ODBC\160\Tools\Binn\SQLCMD.EXE"
if "%SQLCMD%"=="" if exist "%ProgramFiles%\Microsoft SQL Server\160\Tools\Binn\SQLCMD.EXE" set "SQLCMD=%ProgramFiles%\Microsoft SQL Server\160\Tools\Binn\SQLCMD.EXE"
if "%SQLCMD%"=="" if exist "%ProgramFiles%\Microsoft SQL Server\150\Tools\Binn\SQLCMD.EXE" set "SQLCMD=%ProgramFiles%\Microsoft SQL Server\150\Tools\Binn\SQLCMD.EXE"
if "%SQLCMD%"=="" if exist "%ProgramFiles%\Microsoft SQL Server\140\Tools\Binn\SQLCMD.EXE" set "SQLCMD=%ProgramFiles%\Microsoft SQL Server\140\Tools\Binn\SQLCMD.EXE"
if "%SQLCMD%"=="" if exist "%ProgramFiles%\Microsoft SQL Server\130\Tools\Binn\SQLCMD.EXE" set "SQLCMD=%ProgramFiles%\Microsoft SQL Server\130\Tools\Binn\SQLCMD.EXE"

if "%SQLCMD%"=="" (
    echo [ERROR] No se encontro sqlcmd.exe.
    echo         Instalar el Microsoft ODBC Driver for SQL Server o las
    echo         Microsoft Command Line Utilities for SQL Server, o agregar la
    echo         carpeta Tools\Binn al PATH de la tarea.
    exit /b 1
)

if "%SERVER%"=="" (
    echo [ERROR] Falta TQ_JOB_SQL_SERVER - servidor o servidor\instancia.
    echo         Ver deploy/runbooks/jobs-limpieza.md.
    exit /b 2
)

REM ---------------------------------------------------------------------------
REM 2 - Argumentos de conexion
REM     -b  aborta ante un error de SQL y devuelve codigo distinto de 0: sin esto
REM         la tarea se marcaria como correcta con el job caido.
REM     -l / -t  timeouts: una base que no responde tiene que fallar el job, no
REM         dejarlo colgado para siempre.
REM ---------------------------------------------------------------------------
set "AUTENTICACION=-E"
if not "%TQ_JOB_SQL_USER%"=="" (
    set "AUTENTICACION=-U %TQ_JOB_SQL_USER% -P %TQ_JOB_SQL_PWD%"
)

set "BASE_ARGS=-S %SERVER% -d %DB% -b -l 15 -t 120 %AUTENTICACION%"

echo =============================================================
echo  Tourniquet - jobs de limpieza
echo  %DATE% %TIME%
echo  servidor: %SERVER%   base: %DB%
echo  sqlcmd  : %SQLCMD%
if "%TQ_JOB_SQL_USER%"=="" (echo  auth    : integrada de Windows) else (echo  auth    : SQL Server, usuario %TQ_JOB_SQL_USER%)
echo =============================================================

REM ---------------------------------------------------------------------------
REM 3 - Los jobs
REM     El argumento 1 acota la corrida (95, 96, 97, 98 o vacio = los cuatro).
REM     El orden es el de la frecuencia: el de 5 minutos primero, para que si
REM     algo falla el mas importante es el que ya se ejecuto.
REM ---------------------------------------------------------------------------
set "FALLAS=0"

call :correr 95
call :correr 96
call :correr 98
call :correr 97

echo.
echo =============================================================
if "%FALLAS%"=="0" (
    echo  RESULTADO: los jobs ejecutados terminou bien.
    echo  Log: %LOG_DIR%
    exit /b 0
)

echo  RESULTADO: %FALLAS% job(s) fallo(aron). Ver el log.
echo  Log: %LOG_DIR%
exit /b 3

REM ---------------------------------------------------------------------------
REM :correr
REM   Busca el NN-job-*.sql y lo ejecuta. El log de cada uno va a un archivo
REM   con fecha y hora: el historial del Planificador de tareas guarda la salida
REM   del paso, pero no las respuestas de los SELECT de verificacion, y esos
REM   SELECT son justamente los que hay que mirar cuando un job se comporta raro.
REM ---------------------------------------------------------------------------
:correr
set "N=%~1"
if defined SOLO if not "%SOLO%"=="%N%" goto :fin
set "ARCHIVO="
set "PATRON=%SQL_DIR%\%N%-job-*.sql"

REM El `if not exist` va ANTES del `for`: un `for %%F in ("patron")` con el
REM comodin sin expandir se ejecuta UNA vez con el texto del patron, o sea que
REM "si el archivo no existe" se detectaria con un `if not defined ARCHIVO` que
REM nunca se cumple y el job corria con un nombre de archivo que no existe.
if not exist "%PATRON%" (
    echo [ERROR] No se encontro %PATRON%
    set /a FALLAS+=1
    goto :fin
)

for %%F in ("%PATRON%") do if not defined ARCHIVO set "ARCHIVO=%%~fF"

set "NOMBRE=%N%-job"
REM El nombre del log lleva `%RANDOM%` y NO la fecha: `%DATE%` cambia de formato
REM segun el idioma del Windows (dd/mm/aaaa en uno, "Wed mm/dd/yyyy" en otro) y un
REM log con la fecha invertida es peor que un log sin fecha. La corrida queda
REM fechada en la salida de la tarea y en el historial del Planificador.
set "LOG=%LOG_DIR%\%NOMBRE%-%RANDOM%-%RANDOM%.log"

echo.
echo --- %NOMBRE% ---
echo     archivo: %ARCHIVO%
echo     log    : %LOG%

%SQLCMD% %BASE_ARGS% -i "%ARCHIVO%" -o "%LOG%" -W
if errorlevel 1 (
    echo [FALLA] %NOMBRE% devolvio codigo de salida %errorlevel%.
    set /a FALLAS+=1
    goto :fin
)

echo     OK.
:fin
set "ARCHIVO="
goto :eof
