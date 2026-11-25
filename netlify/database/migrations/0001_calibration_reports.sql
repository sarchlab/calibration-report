-- Hosted calibration reports (docs/backend-design.md §3–§4).
-- Tables, the four ingest functions, and the cr_ingest role.

CREATE SCHEMA cr;

CREATE TABLE cr.runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- one URL segment: no '/', no '.' or '..'
  key         text NOT NULL UNIQUE CHECK (key ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$'),
  title       text NOT NULL CHECK (title <> '' AND octet_length(title) <= 500),
  description text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 10000),
  state       text NOT NULL DEFAULT 'running'
              CHECK (state IN ('running', 'completed', 'failed')),
  progress    jsonb NOT NULL CHECK (jsonb_typeof(progress) = 'object' AND octet_length(progress::text) <= 4096),
  revision    bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cr.groups (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES cr.runs ON DELETE CASCADE,
  key    text NOT NULL CHECK (key <> '' AND octet_length(key) <= 200 AND key !~ '[[:cntrl:]]'),
  name   text NOT NULL CHECK (name <> '' AND octet_length(name) <= 200 AND name !~ '[[:cntrl:]]'),
  UNIQUE (run_id, key),
  UNIQUE (id, run_id)
);

CREATE TABLE cr.benchmarks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES cr.runs ON DELETE CASCADE,
  key           text NOT NULL CHECK (key <> '' AND octet_length(key) <= 200 AND key !~ '[[:cntrl:]]'),
  scaling_param text NOT NULL,
  UNIQUE (run_id, key),
  UNIQUE (id, run_id)
);

CREATE TABLE cr.params (
  benchmark_id bigint NOT NULL REFERENCES cr.benchmarks ON DELETE CASCADE,
  key          text NOT NULL CHECK (key <> '' AND octet_length(key) <= 200 AND key !~ '[[:cntrl:]]'),
  unit         text NOT NULL CHECK (octet_length(unit) <= 50 AND unit !~ '[[:cntrl:]]'),
  ordinal      integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (benchmark_id, key),
  UNIQUE (benchmark_id, ordinal)
);

ALTER TABLE cr.benchmarks
  ADD FOREIGN KEY (id, scaling_param) REFERENCES cr.params (benchmark_id, key)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE cr.series (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  benchmark_id bigint NOT NULL REFERENCES cr.benchmarks ON DELETE CASCADE,
  key          text NOT NULL CHECK (key <> '' AND octet_length(key) <= 200 AND key !~ '[[:cntrl:]]'),
  name         text NOT NULL CHECK (name <> '' AND octet_length(name) <= 200 AND name !~ '[[:cntrl:]]'),
  unit         text NOT NULL CHECK (octet_length(unit) <= 50 AND unit !~ '[[:cntrl:]]'),
  role         text CHECK (role IN ('hardware_measurement', 'simulator_output')),
  UNIQUE (benchmark_id, key),
  UNIQUE (id, benchmark_id)
);

CREATE TABLE cr.plots (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       bigint NOT NULL,
  group_id     bigint NOT NULL,
  benchmark_id bigint NOT NULL,
  params       jsonb NOT NULL,
  visible      boolean NOT NULL DEFAULT false,
  CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 2000),
  CHECK (NOT jsonb_path_exists(params, 'strict $.* ? (@.type() != "number" && @.type() != "string" && @.type() != "boolean")')),
  FOREIGN KEY (group_id, run_id) REFERENCES cr.groups (id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (benchmark_id, run_id) REFERENCES cr.benchmarks (id, run_id) ON DELETE CASCADE,
  UNIQUE (group_id, benchmark_id, params),
  UNIQUE (id, group_id, benchmark_id)
);

CREATE TABLE cr.points (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plot_id      bigint NOT NULL,
  group_id     bigint NOT NULL,
  benchmark_id bigint NOT NULL,
  x            double precision NOT NULL CHECK (x NOT IN ('NaN', 'Infinity', '-Infinity')),
  FOREIGN KEY (plot_id, group_id, benchmark_id)
    REFERENCES cr.plots (id, group_id, benchmark_id) ON DELETE CASCADE,
  UNIQUE (plot_id, x),
  UNIQUE (id, benchmark_id)
);

CREATE TABLE cr.observations (
  point_id     bigint NOT NULL,
  benchmark_id bigint NOT NULL,
  series_id    bigint NOT NULL,
  in_values    boolean NOT NULL,
  value        double precision CHECK (value NOT IN ('NaN', 'Infinity', '-Infinity')),
  state        text CHECK (state IN ('queued', 'running', 'failed', 'verification_failed',
                                     'timeout', 'memory_limit', 'unsupported')),
  reason       text CHECK (reason <> '' AND octet_length(reason) <= 1000),
  symbol       text CHECK (symbol <> '' AND octet_length(symbol) <= 16),
  PRIMARY KEY (point_id, series_id),
  FOREIGN KEY (point_id, benchmark_id) REFERENCES cr.points (id, benchmark_id) ON DELETE CASCADE,
  FOREIGN KEY (series_id, benchmark_id) REFERENCES cr.series (id, benchmark_id) ON DELETE CASCADE,
  CHECK (in_values OR value IS NULL),
  CHECK (in_values OR state IS NOT NULL),
  CHECK (state IS NOT NULL OR (reason IS NULL AND symbol IS NULL))
);

CREATE INDEX ON cr.plots (group_id, benchmark_id, id) WHERE visible;
CREATE INDEX ON cr.points (group_id) INCLUDE (id, benchmark_id, plot_id, x);

-- ---------------------------------------------------------------------------
-- Validation helpers (internal; not granted to cr_ingest).
-- Arguments arrive as json, not jsonb, so object key order (parameter
-- declaration order) is preserved.

CREATE FUNCTION cr.fail(message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = message;
END $$;

-- Checks that obj is a JSON object without duplicate or unknown keys and with
-- every required key.
CREATE FUNCTION cr.check_object(obj json, allowed text[], required text[], context text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  k text;
BEGIN
  IF obj IS NULL OR json_typeof(obj) <> 'object' THEN
    PERFORM cr.fail(context || ' must be an object');
  END IF;
  IF (SELECT count(*) <> count(DISTINCT key) FROM json_object_keys(obj) AS key) THEN
    PERFORM cr.fail(context || ' has a duplicate key');
  END IF;
  IF allowed IS NOT NULL THEN
    FOR k IN SELECT json_object_keys(obj) LOOP
      IF NOT k = ANY (allowed) THEN
        PERFORM cr.fail(context || ' has unknown key "' || k || '"');
      END IF;
    END LOOP;
  END IF;
  FOREACH k IN ARRAY coalesce(required, '{}') LOOP
    IF obj -> k IS NULL THEN
      PERFORM cr.fail(context || ' is missing "' || k || '"');
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION cr.check_string(value json, context text, allow_empty boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF value IS NULL OR json_typeof(value) <> 'string' THEN
    PERFORM cr.fail(context || ' must be a string');
  END IF;
  IF NOT allow_empty AND value #>> '{}' = '' THEN
    PERFORM cr.fail(context || ' must not be empty');
  END IF;
  RETURN value #>> '{}';
END $$;

CREATE FUNCTION cr.check_progress(progress json) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  k text;
  v json;
BEGIN
  PERFORM cr.check_object(progress,
    ARRAY['started_at', 'updated_at', 'total', 'completed', 'running', 'queued', 'unsuccessful'],
    ARRAY['total', 'completed', 'running'], 'progress');
  FOR k, v IN SELECT * FROM json_each(progress) LOOP
    IF k IN ('started_at', 'updated_at') THEN
      IF json_typeof(v) NOT IN ('string', 'null') THEN
        PERFORM cr.fail('progress.' || k || ' must be a string or null');
      END IF;
    ELSIF json_typeof(v) <> 'number' THEN
      PERFORM cr.fail('progress.' || k || ' must be a non-negative integer');
    -- Numerically, so 2.0 and 2e0 are integers.
    ELSIF (v #>> '{}')::numeric < 0 OR (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) THEN
      PERFORM cr.fail('progress.' || k || ' must be a non-negative integer');
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION cr.check_report(report json) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  k text;
  v json;
BEGIN
  PERFORM cr.check_object(report, ARRAY['title', 'description', 'live', 'groups'],
    ARRAY['title', 'description', 'live', 'groups'], 'report');
  PERFORM cr.check_string(report -> 'title', 'report.title');
  PERFORM cr.check_string(report -> 'description', 'report.description', true);
  IF json_typeof(report -> 'live') <> 'boolean' THEN
    PERFORM cr.fail('report.live must be a boolean');
  END IF;
  PERFORM cr.check_object(report -> 'groups', NULL, NULL, 'report.groups');
  IF NOT EXISTS (SELECT FROM json_object_keys(report -> 'groups')) THEN
    PERFORM cr.fail('report.groups must not be empty');
  END IF;
  FOR k, v IN SELECT * FROM json_each(report -> 'groups') LOOP
    PERFORM cr.check_object(v, ARRAY['name'], ARRAY['name'], 'report.groups.' || k);
    PERFORM cr.check_string(v -> 'name', 'report.groups.' || k || '.name');
  END LOOP;
END $$;

CREATE FUNCTION cr.check_benchmark(k text, b json) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  p text;
  v json;
  ctx text := 'benchmarks.' || k;
BEGIN
  PERFORM cr.check_object(b, ARRAY['scaling_param', 'params', 'values'],
    ARRAY['scaling_param', 'params', 'values'], ctx);
  PERFORM cr.check_string(b -> 'scaling_param', ctx || '.scaling_param');
  PERFORM cr.check_object(b -> 'params', NULL, NULL, ctx || '.params');
  PERFORM cr.check_object(b -> 'values', NULL, NULL, ctx || '.values');
  IF NOT EXISTS (SELECT FROM json_object_keys(b -> 'params')) THEN
    PERFORM cr.fail(ctx || '.params must not be empty');
  END IF;
  IF NOT EXISTS (SELECT FROM json_object_keys(b -> 'values')) THEN
    PERFORM cr.fail(ctx || '.values must not be empty');
  END IF;
  IF (SELECT count(*) FROM json_object_keys(b -> 'params')) > 32 THEN
    PERFORM cr.fail(ctx || ' declares more than 32 parameters');
  END IF;
  IF (SELECT count(*) FROM json_object_keys(b -> 'values')) > 64 THEN
    PERFORM cr.fail(ctx || ' declares more than 64 series');
  END IF;
  IF (b -> 'params' -> (b ->> 'scaling_param')) IS NULL THEN
    PERFORM cr.fail(ctx || '.scaling_param is not a declared parameter');
  END IF;
  FOR p, v IN SELECT * FROM json_each(b -> 'params') LOOP
    PERFORM cr.check_object(v, ARRAY['unit'], ARRAY['unit'], ctx || '.params.' || p);
    PERFORM cr.check_string(v -> 'unit', ctx || '.params.' || p || '.unit', true);
  END LOOP;
  FOR p, v IN SELECT * FROM json_each(b -> 'values') LOOP
    PERFORM cr.check_object(v, ARRAY['name', 'unit', 'role'], ARRAY['name', 'unit'], ctx || '.values.' || p);
    PERFORM cr.check_string(v -> 'name', ctx || '.values.' || p || '.name');
    PERFORM cr.check_string(v -> 'unit', ctx || '.values.' || p || '.unit', true);
    IF v -> 'role' IS NOT NULL AND (json_typeof(v -> 'role') <> 'string'
        OR v ->> 'role' NOT IN ('hardware_measurement', 'simulator_output')) THEN
      PERFORM cr.fail(ctx || '.values.' || p || '.role must be hardware_measurement or simulator_output');
    END IF;
  END LOOP;
END $$;

-- Locks and returns the run, which must exist.
CREATE FUNCTION cr.lock_run(run_key text) RETURNS cr.runs
LANGUAGE plpgsql AS $$
DECLARE
  run cr.runs;
BEGIN
  SELECT * INTO run FROM cr.runs WHERE key = run_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'run "' || run_key || '" does not exist';
  END IF;
  RETURN run;
END $$;

CREATE FUNCTION cr.require_state(run cr.runs, wanted text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF run.state <> wanted THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'run "' || run.key || '" is ' || run.state || ', not ' || wanted;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Ingest functions (§4). SECURITY DEFINER, executable by cr_ingest only.

CREATE FUNCTION cr.open_run(run_key text, report json, benchmarks json, progress json)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cr, pg_temp AS $$
DECLARE
  run cr.runs;
  created boolean;
  changed boolean;
  g_key text;
  g json;
  b_key text;
  b json;
  b_id bigint;
  stored_scaling text;
  p_key text;
  p json;
  s_key text;
  s json;
  ord integer;
  conflict cr.series;
BEGIN
  PERFORM cr.check_report(report);
  PERFORM cr.check_progress(progress);
  PERFORM cr.check_object(benchmarks, NULL, NULL, 'benchmarks');
  IF NOT EXISTS (SELECT FROM json_each(benchmarks)) THEN
    PERFORM cr.fail('benchmarks must not be empty');
  END IF;
  FOR b_key, b IN SELECT * FROM json_each(benchmarks) LOOP
    PERFORM cr.check_benchmark(b_key, b);
  END LOOP;

  INSERT INTO cr.runs (key, title, description, progress)
  VALUES (run_key, report ->> 'title', report ->> 'description', progress::jsonb)
  ON CONFLICT (key) DO NOTHING;
  created := FOUND;
  run := cr.lock_run(run_key);
  IF run.state = 'completed' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'run "' || run_key || '" is completed';
  END IF;
  changed := created;
  IF NOT created THEN
    IF run.title <> report ->> 'title' OR run.description <> report ->> 'description' THEN
      UPDATE cr.runs SET title = report ->> 'title', description = report ->> 'description'
      WHERE id = run.id;
      changed := true;
    END IF;
    IF run.state = 'failed' THEN
      UPDATE cr.runs SET state = 'running' WHERE id = run.id;
      changed := true;
    END IF;
  END IF;

  FOR g_key, g IN SELECT * FROM json_each(report -> 'groups') LOOP
    IF EXISTS (SELECT FROM cr.groups WHERE run_id = run.id AND key = g_key) THEN
      IF NOT EXISTS (SELECT FROM cr.groups WHERE run_id = run.id AND key = g_key AND name = g ->> 'name') THEN
        PERFORM cr.fail('report.groups.' || g_key || '.name differs from the stored name');
      END IF;
    ELSE
      INSERT INTO cr.groups (run_id, key, name) VALUES (run.id, g_key, g ->> 'name');
      changed := true;
    END IF;
  END LOOP;

  FOR b_key, b IN SELECT * FROM json_each(benchmarks) LOOP
    SELECT id, scaling_param INTO b_id, stored_scaling
    FROM cr.benchmarks WHERE run_id = run.id AND key = b_key;
    IF FOUND THEN
      IF stored_scaling <> b ->> 'scaling_param' THEN
        PERFORM cr.fail('benchmarks.' || b_key || '.scaling_param differs from the stored value');
      END IF;
      -- The parameter set (names, units, order) is frozen at declaration:
      -- every (ordinal, key, unit) must match on both sides.
      IF EXISTS (
        SELECT FROM (SELECT ordinal, key, unit FROM cr.params WHERE benchmark_id = b_id) stored
        FULL JOIN (
          SELECT (n - 1)::integer AS ordinal, d.key, d.value ->> 'unit' AS unit
          FROM json_each(b -> 'params') WITH ORDINALITY AS d(key, value, n)
        ) declared USING (ordinal, key, unit)
        WHERE stored.ordinal IS NULL OR declared.ordinal IS NULL
      ) THEN
        PERFORM cr.fail('benchmarks.' || b_key || '.params differ from the stored parameters');
      END IF;
    ELSE
      INSERT INTO cr.benchmarks (run_id, key, scaling_param)
      VALUES (run.id, b_key, b ->> 'scaling_param') RETURNING id INTO b_id;
      ord := 0;
      FOR p_key, p IN SELECT * FROM json_each(b -> 'params') LOOP
        INSERT INTO cr.params (benchmark_id, key, unit, ordinal) VALUES (b_id, p_key, p ->> 'unit', ord);
        ord := ord + 1;
      END LOOP;
      changed := true;
    END IF;

    FOR s_key, s IN SELECT * FROM json_each(b -> 'values') LOOP
      IF EXISTS (SELECT FROM cr.series WHERE benchmark_id = b_id AND key = s_key) THEN
        IF NOT EXISTS (SELECT FROM cr.series WHERE benchmark_id = b_id AND key = s_key
                       AND name = s ->> 'name' AND unit = s ->> 'unit'
                       AND role IS NOT DISTINCT FROM s ->> 'role') THEN
          PERFORM cr.fail('benchmarks.' || b_key || '.values.' || s_key || ' differs from the stored series');
        END IF;
      ELSE
        -- A role-tagged key means the same series everywhere in the run.
        SELECT se.* INTO conflict FROM cr.series se JOIN cr.benchmarks be ON be.id = se.benchmark_id
        WHERE be.run_id = run.id AND se.key = s_key
          AND (se.role IS NOT NULL OR s ->> 'role' IS NOT NULL)
          AND (se.name, se.unit, se.role) IS DISTINCT FROM (s ->> 'name', s ->> 'unit', s ->> 'role')
        LIMIT 1;
        IF FOUND THEN
          PERFORM cr.fail('benchmarks.' || b_key || '.values.' || s_key
            || ' differs from the role-tagged series "' || s_key || '" declared by another benchmark');
        END IF;
        INSERT INTO cr.series (benchmark_id, key, name, unit, role)
        VALUES (b_id, s_key, s ->> 'name', s ->> 'unit', s ->> 'role');
        changed := true;
      END IF;
    END LOOP;
  END LOOP;

  IF changed THEN
    IF (SELECT count(*) FROM cr.groups WHERE run_id = run.id) > 16 THEN
      PERFORM cr.fail('a run has at most 16 groups');
    END IF;
    IF (SELECT count(*) FROM cr.benchmarks WHERE run_id = run.id) > 1000 THEN
      PERFORM cr.fail('a run has at most 1,000 benchmarks');
    END IF;
    -- Appending series can exceed the per-benchmark cap that each call checks.
    SELECT be.key INTO b_key FROM cr.benchmarks be JOIN cr.series se ON se.benchmark_id = be.id
    WHERE be.run_id = run.id AND be.key IN (SELECT json_object_keys(benchmarks))
    GROUP BY be.id, be.key HAVING count(*) > 64 LIMIT 1;
    IF FOUND THEN
      PERFORM cr.fail('benchmarks.' || b_key || ' has more than 64 series');
    END IF;
    IF (SELECT count(DISTINCT se.key) FROM cr.series se JOIN cr.benchmarks be ON be.id = se.benchmark_id
        WHERE be.run_id = run.id AND se.role IS NOT NULL) > 32 THEN
      PERFORM cr.fail('a run has at most 32 role-tagged series keys');
    END IF;
    IF octet_length(cr.declared_metadata(run.id)::text) > 2 * 1024 * 1024 THEN
      PERFORM cr.fail('a run''s declared metadata exceeds 2 MB');
    END IF;
    UPDATE cr.runs SET revision = revision + 1, updated_at = now() WHERE id = run.id;
  END IF;
  RETURN run.id;
END $$;

-- report.groups and benchmarks of a run, as stored (used for the size limit).
CREATE FUNCTION cr.declared_metadata(run bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'report', (SELECT jsonb_build_object('title', title, 'description', description,
                 'groups', (SELECT coalesce(jsonb_object_agg(key, jsonb_build_object('name', name)), '{}')
                            FROM cr.groups WHERE run_id = run))
               FROM cr.runs WHERE id = run),
    'benchmarks', (SELECT coalesce(jsonb_object_agg(b.key, jsonb_build_object(
        'scaling_param', b.scaling_param,
        'params', (SELECT jsonb_object_agg(p.key, jsonb_build_object('unit', p.unit))
                   FROM cr.params p WHERE p.benchmark_id = b.id),
        'values', (SELECT jsonb_object_agg(s.key, jsonb_strip_nulls(
                     jsonb_build_object('name', s.name, 'unit', s.unit, 'role', s.role)))
                   FROM cr.series s WHERE s.benchmark_id = b.id))), '{}')
      FROM cr.benchmarks b WHERE b.run_id = run));
$$;

CREATE FUNCTION cr.put_points(run_key text, points json, progress json DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cr, pg_temp AS $$
DECLARE
  run cr.runs;
  point json;
  i bigint;
  ctx text;
  g_id bigint;
  b_id bigint;
  b_scaling text;
  nsp jsonb;
  px double precision;
  plot bigint;
  pt bigint;
  touched bigint[] := '{}';
  s_key text;
  v json;
  status json;
  s_id bigint;
BEGIN
  run := cr.lock_run(run_key);
  PERFORM cr.require_state(run, 'running');
  IF progress IS NOT NULL AND json_typeof(progress) <> 'null' THEN
    PERFORM cr.check_progress(progress);
  END IF;
  IF points IS NULL OR json_typeof(points) <> 'array' THEN
    PERFORM cr.fail('points must be an array');
  END IF;

  FOR point, i IN SELECT * FROM json_array_elements(points) WITH ORDINALITY LOOP
    ctx := 'points[' || (i - 1) || ']';
    PERFORM cr.check_object(point, ARRAY['group', 'benchmark', 'x', 'non_scaling_params', 'values', 'statuses'],
      ARRAY['group', 'benchmark', 'x', 'non_scaling_params', 'values'], ctx);
    SELECT id INTO g_id FROM cr.groups
    WHERE run_id = run.id AND key = cr.check_string(point -> 'group', ctx || '.group');
    IF NOT FOUND THEN
      PERFORM cr.fail(ctx || '.group "' || (point ->> 'group') || '" is not declared');
    END IF;
    SELECT id, scaling_param INTO b_id, b_scaling FROM cr.benchmarks
    WHERE run_id = run.id AND key = cr.check_string(point -> 'benchmark', ctx || '.benchmark');
    IF NOT FOUND THEN
      PERFORM cr.fail(ctx || '.benchmark "' || (point ->> 'benchmark') || '" is not declared');
    END IF;
    IF json_typeof(point -> 'x') <> 'number' THEN
      PERFORM cr.fail(ctx || '.x must be a number');
    END IF;
    px := (point ->> 'x')::double precision;

    PERFORM cr.check_object(point -> 'non_scaling_params', NULL, NULL, ctx || '.non_scaling_params');
    IF (SELECT array_agg(key ORDER BY key) FROM json_object_keys(point -> 'non_scaling_params') AS key)
       IS DISTINCT FROM
       (SELECT array_agg(key ORDER BY key) FROM cr.params WHERE benchmark_id = b_id AND key <> b_scaling) THEN
      PERFORM cr.fail(ctx || '.non_scaling_params must name exactly the declared parameters other than "'
        || b_scaling || '"');
    END IF;
    nsp := (point -> 'non_scaling_params')::jsonb;

    PERFORM cr.check_object(point -> 'values', NULL, NULL, ctx || '.values');
    IF NOT EXISTS (SELECT FROM json_object_keys(point -> 'values')) THEN
      PERFORM cr.fail(ctx || '.values must not be empty');
    END IF;
    IF point -> 'statuses' IS NOT NULL THEN
      PERFORM cr.check_object(point -> 'statuses', NULL, NULL, ctx || '.statuses');
    END IF;

    INSERT INTO cr.plots (run_id, group_id, benchmark_id, params)
    VALUES (run.id, g_id, b_id, nsp)
    ON CONFLICT (group_id, benchmark_id, params) DO NOTHING;
    SELECT id INTO plot FROM cr.plots WHERE group_id = g_id AND benchmark_id = b_id AND params = nsp;
    INSERT INTO cr.points (plot_id, group_id, benchmark_id, x) VALUES (plot, g_id, b_id, px)
    ON CONFLICT (plot_id, x) DO NOTHING;
    SELECT id INTO pt FROM cr.points WHERE plot_id = plot AND x = px;
    IF NOT plot = ANY (touched) THEN
      touched := touched || plot;
    END IF;

    -- Each series named in values or statuses replaces its stored observation.
    FOR s_key IN
      SELECT key FROM json_object_keys(point -> 'values') AS key
      UNION
      SELECT key FROM json_object_keys(coalesce(point -> 'statuses', '{}')) AS key
    LOOP
      SELECT id INTO s_id FROM cr.series WHERE benchmark_id = b_id AND key = s_key;
      IF NOT FOUND THEN
        PERFORM cr.fail(ctx || ': series "' || s_key || '" is not declared by benchmark "'
          || (point ->> 'benchmark') || '"');
      END IF;
      v := point -> 'values' -> s_key;
      IF v IS NOT NULL AND json_typeof(v) NOT IN ('number', 'null') THEN
        PERFORM cr.fail(ctx || '.values.' || s_key || ' must be a number or null');
      END IF;
      status := point -> 'statuses' -> s_key;
      IF status IS NOT NULL THEN
        PERFORM cr.check_object(status, ARRAY['state', 'reason', 'symbol'], ARRAY['state'],
          ctx || '.statuses.' || s_key);
        PERFORM cr.check_string(status -> 'state', ctx || '.statuses.' || s_key || '.state');
        IF status ->> 'state' NOT IN ('queued', 'running', 'failed', 'verification_failed',
                                     'timeout', 'memory_limit', 'unsupported') THEN
          PERFORM cr.fail(ctx || '.statuses.' || s_key || '.state "' || (status ->> 'state') || '" is unknown');
        END IF;
        IF status -> 'reason' IS NOT NULL THEN
          PERFORM cr.check_string(status -> 'reason', ctx || '.statuses.' || s_key || '.reason');
        END IF;
        IF status -> 'symbol' IS NOT NULL THEN
          PERFORM cr.check_string(status -> 'symbol', ctx || '.statuses.' || s_key || '.symbol');
        END IF;
      END IF;
      INSERT INTO cr.observations AS o (point_id, benchmark_id, series_id, in_values, value, state, reason, symbol)
      VALUES (pt, b_id, s_id, v IS NOT NULL,
              CASE WHEN json_typeof(v) = 'number' THEN (v #>> '{}')::double precision END,
              status ->> 'state', status ->> 'reason', status ->> 'symbol')
      ON CONFLICT (point_id, series_id) DO UPDATE
        SET in_values = excluded.in_values, value = excluded.value, state = excluded.state,
            reason = excluded.reason, symbol = excluded.symbol;
    END LOOP;
  END LOOP;

  -- Same rule as indexReport's row filter: a finite value, or a drawn status.
  UPDATE cr.plots pl SET visible = EXISTS (
    SELECT FROM cr.points p JOIN cr.observations o ON o.point_id = p.id
    WHERE p.plot_id = pl.id
      AND (o.value IS NOT NULL
           OR o.state IN ('failed', 'verification_failed', 'timeout', 'memory_limit', 'unsupported', 'running')))
  WHERE pl.id = ANY (touched);

  UPDATE cr.runs SET
    progress = CASE WHEN put_points.progress IS NULL OR json_typeof(put_points.progress) = 'null'
                    THEN cr.runs.progress ELSE put_points.progress::jsonb END,
    revision = revision + 1,
    updated_at = now()
  WHERE id = run.id;
END $$;

CREATE FUNCTION cr.heartbeat(run_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cr, pg_temp AS $$
DECLARE
  run cr.runs;
BEGIN
  run := cr.lock_run(run_key);
  PERFORM cr.require_state(run, 'running');
  UPDATE cr.runs SET updated_at = now() WHERE id = run.id;
END $$;

CREATE FUNCTION cr.finish_run(run_key text, state text, progress json DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cr, pg_temp AS $$
DECLARE
  run cr.runs;
BEGIN
  IF finish_run.state IS NULL OR finish_run.state NOT IN ('completed', 'failed') THEN
    PERFORM cr.fail('state must be completed or failed');
  END IF;
  IF progress IS NOT NULL AND json_typeof(progress) <> 'null' THEN
    PERFORM cr.check_progress(progress);
  END IF;
  run := cr.lock_run(run_key);
  IF run.state = finish_run.state THEN
    RETURN;  -- replay of a finish that already succeeded
  END IF;
  PERFORM cr.require_state(run, 'running');
  UPDATE cr.runs SET
    state = finish_run.state,
    progress = CASE WHEN finish_run.progress IS NULL OR json_typeof(finish_run.progress) = 'null'
                    THEN cr.runs.progress ELSE finish_run.progress::jsonb END,
    revision = revision + 1,
    updated_at = now()
  WHERE id = run.id;
END $$;

-- ---------------------------------------------------------------------------
-- Ingest role. The team owner enables it once by hand:
--   ALTER ROLE cr_ingest LOGIN PASSWORD '...';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cr_ingest') THEN
    CREATE ROLE cr_ingest NOLOGIN;
  END IF;
END $$;

REVOKE ALL ON SCHEMA cr FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA cr FROM PUBLIC;
GRANT USAGE ON SCHEMA cr TO cr_ingest;
GRANT EXECUTE ON FUNCTION
  cr.open_run(text, json, json, json),
  cr.put_points(text, json, json),
  cr.heartbeat(text),
  cr.finish_run(text, text, json)
TO cr_ingest;
