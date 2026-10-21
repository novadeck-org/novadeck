# The image the Linux engines are compiled in (see Package's Build Voice Engine): an old
# enough Ubuntu that the engines' glibc floor is its glibc, whatever the runner image
# moves to, with the toolchain the build calls. The base is given by the workflow, which
# pins it by digest and checks the engines against its glibc.
ARG BASE
FROM ${BASE}

ENV DEBIAN_FRONTEND=noninteractive

# The compiler, CMake and git (which applies the patches) from the distribution, and the
# Vulkan loader's development files to link against.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils git make cmake g++ libvulkan-dev spirv-headers \
  && rm -rf /var/lib/apt/lists/*

# The Vulkan backend needs newer headers and a newer glslc than this Ubuntu packages. The
# SDK's tools need glibc 2.34 at most, so it does not raise the floor. Pinned by checksum,
# like the version Windows installs.
ARG VULKAN_SDK_VERSION=1.4.363.0
ARG VULKAN_SDK_SHA256=197962f5cbf80baf2775a03336a01cee7c8745686c65aaa70d3f751ade4d7e43
RUN curl -fsSL -o /tmp/sdk.tar.xz "https://sdk.lunarg.com/sdk/download/${VULKAN_SDK_VERSION}/linux/vulkansdk-linux-x86_64-${VULKAN_SDK_VERSION}.tar.xz" \
  && echo "${VULKAN_SDK_SHA256}  /tmp/sdk.tar.xz" | sha256sum --check - \
  && mkdir /opt/vulkan \
  && tar -xJf /tmp/sdk.tar.xz -C /opt/vulkan --strip-components=2 "${VULKAN_SDK_VERSION}/x86_64" \
  && rm /tmp/sdk.tar.xz
ENV VULKAN_SDK=/opt/vulkan
ENV PATH=/opt/vulkan/bin:$PATH

# The build script is TypeScript that Node runs as it is, as CI's does.
ARG NODE_VERSION=26.12.0
ARG NODE_SHA256=fd47865ecd6391ebb431fc815e01b9135bf83ded5cf373247e9331e196b7aded
RUN curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum --check - \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
  && rm /tmp/node.tar.xz
