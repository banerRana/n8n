import { defineStore } from 'pinia';
import { ref, watch, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useRootStore } from '@/stores/root.store';
import * as projectsApi from '@/api/projects.api';
import * as workflowsEEApi from '@/api/workflows.ee';
import * as credentialsEEApi from '@/api/credentials.ee';
import type {
	Project,
	ProjectCreateRequest,
	ProjectListItem,
	ProjectUpdateRequest,
	ProjectsCount,
} from '@/types/projects.types';
import { ProjectTypes } from '@/types/projects.types';
import { useSettingsStore } from '@/stores/settings.store';
import { hasPermission } from '@/utils/rbac/permissions';
import type { IWorkflowDb } from '@/Interface';
import { useWorkflowsStore } from '@/stores/workflows.store';
import { useCredentialsStore } from '@/stores/credentials.store';
import { STORES } from '@/constants';
import { useUsersStore } from '@/stores/users.store';
import { getResourcePermissions } from '@/permissions';

export const useProjectsStore = defineStore(STORES.PROJECTS, () => {
	const route = useRoute();
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();
	const workflowsStore = useWorkflowsStore();
	const credentialsStore = useCredentialsStore();
	const usersStore = useUsersStore();

	const projects = ref<ProjectListItem[]>([]);
	const myProjects = ref<ProjectListItem[]>([]);
	const personalProject = ref<Project | null>(null);
	const currentProject = ref<Project | null>(null);
	const projectsCount = ref<ProjectsCount>({
		personal: 0,
		team: 0,
		public: 0,
	});
	const projectNavActiveIdState = ref<string | string[] | null>(null);

	const globalProjectPermissions = computed(
		() => getResourcePermissions(usersStore.currentUser?.globalScopes).project,
	);
	const availableProjects = computed(() =>
		globalProjectPermissions.value.list ? projects.value : myProjects.value,
	);

	const currentProjectId = computed(
		() =>
			(route.params?.projectId as string | undefined) ??
			(route.query?.projectId as string | undefined) ??
			currentProject.value?.id,
	);
	const isProjectHome = computed(() => route.path.includes('home'));
	const personalProjects = computed(() =>
		projects.value.filter((p) => p.type === ProjectTypes.Personal),
	);
	const teamProjects = computed(() => projects.value.filter((p) => p.type === ProjectTypes.Team));
	const teamProjectsLimit = computed(() => settingsStore.settings.enterprise.projects.team.limit);
	const isTeamProjectFeatureEnabled = computed<boolean>(() => teamProjectsLimit.value !== 0);
	const hasUnlimitedProjects = computed<boolean>(() => teamProjectsLimit.value === -1);
	const isTeamProjectLimitExceeded = computed<boolean>(
		() => projectsCount.value.team >= teamProjectsLimit.value,
	);
	const canCreateProjects = computed<boolean>(
		() =>
			hasUnlimitedProjects.value ||
			(isTeamProjectFeatureEnabled.value && !isTeamProjectLimitExceeded.value),
	);
	const hasPermissionToCreateProjects = computed(() =>
		hasPermission(['rbac'], { rbac: { scope: 'project:create' } }),
	);

	const projectNavActiveId = computed<string | string[] | null>({
		get: () => route?.params?.projectId ?? projectNavActiveIdState.value,
		set: (value: string | string[] | null) => {
			projectNavActiveIdState.value = value;
		},
	});

	const setCurrentProject = (project: Project | null) => {
		currentProject.value = project;
	};

	const getAllProjects = async () => {
		projects.value = await projectsApi.getAllProjects(rootStore.restApiContext);
		return projects.value;
	};

	const getMyProjects = async () => {
		myProjects.value = await projectsApi.getMyProjects(rootStore.restApiContext);
		return myProjects.value;
	};

	const getPersonalProject = async () => {
		personalProject.value = await projectsApi.getPersonalProject(rootStore.restApiContext);
	};

	const getAvailableProjects = async () => {
		if (globalProjectPermissions.value.list) {
			return await getAllProjects();
		} else {
			return await getMyProjects();
		}
	};

	const fetchProject = async (id: string) =>
		await projectsApi.getProject(rootStore.restApiContext, id);

	const getProject = async (id: string) => {
		currentProject.value = await fetchProject(id);
	};

	const createProject = async (project: ProjectCreateRequest): Promise<Project> => {
		const newProject = await projectsApi.createProject(rootStore.restApiContext, project);
		await getProjectsCount();
		myProjects.value = [...myProjects.value, newProject as unknown as ProjectListItem];
		return newProject;
	};

	const updateProject = async (projectData: ProjectUpdateRequest): Promise<void> => {
		await projectsApi.updateProject(rootStore.restApiContext, projectData);
		const projectIndex = myProjects.value.findIndex((p) => p.id === projectData.id);
		if (projectIndex !== -1) {
			myProjects.value[projectIndex].name = projectData.name;
		}
		if (currentProject.value) {
			currentProject.value.name = projectData.name;
		}
		if (projectData.relations) {
			await getProject(projectData.id);
		}
	};

	const deleteProject = async (projectId: string, transferId?: string): Promise<void> => {
		await projectsApi.deleteProject(rootStore.restApiContext, projectId, transferId);
		await getProjectsCount();
		myProjects.value = myProjects.value.filter((p) => p.id !== projectId);
	};

	const getProjectsCount = async () => {
		projectsCount.value = await projectsApi.getProjectsCount(rootStore.restApiContext);
	};

	const setProjectNavActiveIdByWorkflowHomeProject = async (
		homeProject?: IWorkflowDb['homeProject'],
	) => {
		if (homeProject?.type === ProjectTypes.Personal) {
			projectNavActiveId.value = 'home';
		} else {
			projectNavActiveId.value = homeProject?.id ?? null;
			if (homeProject?.id && !currentProjectId.value) {
				await getProject(homeProject?.id);
			}
		}
	};

	const moveResourceToProject = async (
		resourceType: 'workflow' | 'credential',
		resourceId: string,
		projectId: string,
	) => {
		if (resourceType === 'workflow') {
			await workflowsEEApi.moveWorkflowToProject(rootStore.restApiContext, resourceId, projectId);
			await workflowsStore.fetchAllWorkflows({ filter: { projectId: currentProjectId.value } });
		} else {
			await credentialsEEApi.moveCredentialToProject(
				rootStore.restApiContext,
				resourceId,
				projectId,
			);
			await credentialsStore.fetchAllCredentials(currentProjectId.value);
		}
	};

	watch(
		route,
		async (newRoute) => {
			projectNavActiveId.value = null;

			if (newRoute?.path?.includes('home')) {
				projectNavActiveId.value = 'home';
				setCurrentProject(null);
			}

			if (newRoute?.path?.includes('workflow/')) {
				if (currentProjectId.value) {
					projectNavActiveId.value = currentProjectId.value;
				} else {
					projectNavActiveId.value = 'home';
				}
			}

			if (!newRoute?.params?.projectId) {
				return;
			}

			await getProject(newRoute.params.projectId as string);
		},
		{ immediate: true },
	);

	return {
		projects,
		availableProjects,
		myProjects,
		personalProject,
		currentProject,
		currentProjectId,
		isProjectHome,
		personalProjects,
		teamProjects,
		teamProjectsLimit,
		hasUnlimitedProjects,
		canCreateProjects,
		hasPermissionToCreateProjects,
		isTeamProjectFeatureEnabled,
		projectNavActiveId,
		setCurrentProject,
		getAllProjects,
		getMyProjects,
		getPersonalProject,
		getAvailableProjects,
		fetchProject,
		getProject,
		createProject,
		updateProject,
		deleteProject,
		getProjectsCount,
		setProjectNavActiveIdByWorkflowHomeProject,
		moveResourceToProject,
	};
});
