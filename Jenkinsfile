pipeline {
  agent {
    kubernetes {
      cloud 'kubernetes'
      namespace 'jenkins'
      yamlFile 'k8s/jenkins-agent.yaml'
      defaultContainer 'node'
    }
  }
  options {
    disableConcurrentBuilds()
    timestamps()
    timeout(time: 30, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }
  environment {
    IMAGE_REPOSITORY = 'harbor.sayinfo.co.kr/devurllist/devurllist'
    DB_HOST = '127.0.0.1'
    DB_PORT = '3306'
    DB_NAME = 'devurllist_ci_test'
    DB_USER = 'devurllist_test'
    DB_PASSWORD = 'local-test-only'
  }
  stages {
    stage('Validate') {
      steps {
        script {
          env.IMAGE_TAG = "build-${env.BUILD_NUMBER}-sha-${env.GIT_COMMIT.take(12)}"
          env.MIGRATION_JOB = "devurllist-migrate-${env.BUILD_NUMBER}-${env.GIT_COMMIT.take(12)}"
        }
        sh 'npm ci --ignore-scripts --no-audit --no-fund'
        sh 'npm test'
        sh 'node scripts/wait-mariadb.js'
        sh 'npm run test:mariadb'
      }
    }
    stage('Build image') {
      steps {
        sh 'mkdir -p .release'
        container('buildkit') {
          sh '''
            set -eu
            test -s /home/user/.docker/config.json
            buildctl-daemonless.sh build --frontend dockerfile.v0 \
              --local context="$WORKSPACE" --local dockerfile="$WORKSPACE" \
              --opt platform=linux/amd64 --output "type=image,name=$IMAGE_REPOSITORY:$IMAGE_TAG,push=true" \
              --metadata-file "$WORKSPACE/.release/image-metadata.json"
          '''
        }
        sh 'node scripts/prepare-release.js'
        archiveArtifacts artifacts: '.release/image-metadata.json,.release/image-ref.txt,.release/app.yaml,.release/migration-job.yaml', fingerprint: true
      }
    }
    stage('Deploy') {
      steps {
        withCredentials([file(credentialsId: 'sayinfo-local-root-ca-v2-crt', variable: 'NODE_EXTRA_CA_CERTS')]) {
        sh '''
          set -eu
          mkdir -p .tools
          curl -fsSLo .tools/kubectl https://dl.k8s.io/release/v1.36.6/bin/linux/amd64/kubectl
          curl -fsSLo .tools/kubectl.sha256 https://dl.k8s.io/release/v1.36.6/bin/linux/amd64/kubectl.sha256
          printf '%s  %s\n' "$(cat .tools/kubectl.sha256)" .tools/kubectl | sha256sum -c -
          chmod 0755 .tools/kubectl
          PATH="$WORKSPACE/.tools:$PATH" sh scripts/deploy-k8s.sh
        '''
        }
      }
    }
  }
}
