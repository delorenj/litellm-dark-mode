ARG LITELLM_IMAGE=ghcr.io/berriai/litellm:main-stable
FROM ${LITELLM_IMAGE}

ARG LITELLM_DARK_MODE_VERSION=dev

COPY docker/patch-image.py /tmp/litellm-dark-mode-patch.py
COPY assets/litellm-dark-mode.css /tmp/litellm-dark-mode.css

RUN python /tmp/litellm-dark-mode-patch.py \
      --css /tmp/litellm-dark-mode.css \
      --version "${LITELLM_DARK_MODE_VERSION}" \
    && rm -f /tmp/litellm-dark-mode-patch.py /tmp/litellm-dark-mode.css

LABEL io.github.delorenj.litellm-dark-mode.version="${LITELLM_DARK_MODE_VERSION}"
